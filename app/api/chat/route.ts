import { NextResponse, type NextRequest } from "next/server";
import { getSupabase, type MatchedChunk } from "@/lib/supabase";
import { embed } from "@/lib/openai";
import { getAnthropic, CHAT_MODEL } from "@/lib/anthropic";
import { logEnvStatus, missingEnvVars } from "@/lib/env-debug";

export const runtime = "nodejs";
export const maxDuration = 60;

const SYSTEM_PROMPT =
  "Answer using only the provided context. After your answer, list the exact source chunks you used as numbered citations.";

// Cap prior turns sent to the model. 40 turns × ~600 tokens budgets ~24k
// tokens — well within Sonnet's window and enough for "pick up where I
// left off" continuity.
const HISTORY_TURNS = 40;

const MAX_TITLE_LENGTH = 60;

type Citation = {
  index: number;
  document_id: string;
  document_name: string;
  chunk_index: number;
  content: string;
  similarity: number;
};

type ChatBody = {
  query?: string;
  conversation_id?: string | null;
  document_id?: string | null;
};

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function deriveTitle(query: string): string {
  const trimmed = query.replace(/\s+/g, " ").trim();
  if (trimmed.length <= MAX_TITLE_LENGTH) return trimmed;
  return trimmed.slice(0, MAX_TITLE_LENGTH - 1).trimEnd() + "…";
}

export async function GET(request: NextRequest) {
  try {
    const missing = missingEnvVars();
    if (missing.length > 0) {
      return jsonError(`Missing env vars: ${missing.join(", ")}`, 500);
    }
    const url = new URL(request.url);
    const conversationId = url.searchParams.get("conversation_id");
    if (!conversationId) {
      return jsonError("Missing conversation_id.", 400);
    }

    const sb = getSupabase();
    const { data, error } = await sb
      .from("messages")
      .select("id, role, content, citations, created_at")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: true });

    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ messages: data ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[chat.GET] uncaught", err);
    return jsonError(message, 500);
  }
}

export async function POST(request: NextRequest) {
  logEnvStatus("chat.POST");

  try {
    const missing = missingEnvVars();
    if (missing.length > 0) {
      return jsonError(
        `Server is missing required environment variables: ${missing.join(", ")}.`,
        500
      );
    }

    let body: ChatBody;
    try {
      body = (await request.json()) as ChatBody;
    } catch {
      return jsonError("Invalid JSON body.", 400);
    }

    const query = body.query?.trim();
    if (!query) return jsonError("Missing 'query'.", 400);

    const sb = getSupabase();

    // Resolve which conversation we're appending to. Either client gave
    // us one, or we create a new one for this scope.
    let conversationId = body.conversation_id ?? null;
    let conversationDocumentId: string | null = body.document_id ?? null;

    if (conversationId) {
      const { data: conv, error: convErr } = await sb
        .from("conversations")
        .select("id, document_id")
        .eq("id", conversationId)
        .maybeSingle();
      if (convErr) {
        console.error("[chat] failed to load conversation", convErr);
        return jsonError(convErr.message, 500);
      }
      if (!conv) {
        return jsonError("Conversation not found.", 404);
      }
      conversationDocumentId = conv.document_id;
    } else {
      const { data: created, error: createErr } = await sb
        .from("conversations")
        .insert({
          document_id: conversationDocumentId,
          title: deriveTitle(query),
        })
        .select("id, document_id")
        .single();
      if (createErr || !created) {
        const hint =
          createErr &&
          /conversations.*does not exist|relation .* does not exist/i.test(
            createErr.message ?? ""
          )
            ? " — rerun supabase/schema.sql so the conversations table exists."
            : "";
        console.error("[chat] failed to create conversation", createErr);
        return jsonError((createErr?.message ?? "Insert failed") + hint, 500);
      }
      conversationId = created.id;
      conversationDocumentId = created.document_id;
    }

    // 1. Recall prior turns in this conversation so the model has full context.
    let priorTurns: { role: "user" | "assistant"; content: string }[] = [];
    {
      const { data: history, error: historyErr } = await sb
        .from("messages")
        .select("role, content")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .limit(HISTORY_TURNS);
      if (historyErr) {
        console.warn("[chat] could not load history", historyErr.message);
      } else if (history) {
        priorTurns = history
          .reverse()
          .map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          }));
      }
    }

    // 2. Retrieve relevant chunks for the new question, filtered to the
    // conversation's document if any.
    const queryEmbedding = await embed(query);
    const { data: rpcData, error: rpcErr } = await sb.rpc("match_chunks", {
      query_embedding: queryEmbedding as unknown as string,
      match_count: 5,
      filter_document_id: conversationDocumentId,
    });
    if (rpcErr) {
      console.error("[chat] match_chunks failed", rpcErr);
      return jsonError(rpcErr.message, 500);
    }

    const matches = (rpcData ?? []) as MatchedChunk[];
    const citations: Citation[] = matches.map((m, i) => ({
      index: i + 1,
      document_id: m.document_id,
      document_name: m.document_name,
      chunk_index: m.chunk_index,
      content: m.content,
      similarity: m.similarity,
    }));

    const contextBlock = citations.length
      ? citations
          .map(
            (c) =>
              `[${c.index}] ${c.document_name} — chunk ${c.chunk_index}\n${c.content}`
          )
          .join("\n\n---\n\n")
      : "(no matching chunks found)";

    const userMessage =
      `Context:\n\n${contextBlock}\n\n` +
      `Question: ${query}\n\n` +
      `If the context does not contain the answer, say so plainly. ` +
      `Use citations like [1], [2] inline where you draw on a specific chunk.`;

    const encoder = new TextEncoder();
    const anthropic = getAnthropic();
    const activeConversationId = conversationId;

    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) =>
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));

        // Tell the client which conversation this turn belongs to so it
        // can update its active conversation if we just created one.
        send({ type: "conversation", conversation_id: activeConversationId });
        send({ type: "citations", citations });

        let assistantText = "";
        let succeeded = false;

        try {
          const llmStream = anthropic.messages.stream({
            model: CHAT_MODEL,
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            messages: [
              ...priorTurns,
              { role: "user", content: userMessage },
            ],
          });

          for await (const event of llmStream) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              assistantText += event.delta.text;
              send({ type: "delta", text: event.delta.text });
            }
          }

          succeeded = true;
          send({ type: "done" });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Stream error";
          console.error("[chat] stream error", err);
          send({ type: "error", error: message });
        } finally {
          if (succeeded && assistantText) {
            try {
              const { error: persistErr } = await sb
                .from("messages")
                .insert([
                  {
                    conversation_id: activeConversationId,
                    role: "user",
                    content: query,
                  },
                  {
                    conversation_id: activeConversationId,
                    role: "assistant",
                    content: assistantText,
                    citations,
                  },
                ]);
              if (persistErr) {
                const hint =
                  /relation .* does not exist|messages.*does not exist/i.test(
                    persistErr.message
                  )
                    ? " — rerun supabase/schema.sql so the messages table exists."
                    : "";
                console.error("[chat] PERSIST FAILED", persistErr);
                send({
                  type: "persist_error",
                  error: persistErr.message + hint,
                });
              } else {
                console.log("[chat] persisted turn", {
                  conversation_id: activeConversationId,
                });
              }
            } catch (persistErr) {
              const message =
                persistErr instanceof Error
                  ? persistErr.message
                  : "Unknown persist error";
              console.error("[chat] persist threw", persistErr);
              send({ type: "persist_error", error: message });
            }
          }
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[chat] uncaught", err);
    return jsonError(`Chat crashed: ${message}`, 500);
  }
}

export type { Citation };
