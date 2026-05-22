import { NextResponse, type NextRequest } from "next/server";
import { getSupabase, type MatchedChunk } from "@/lib/supabase";
import { embed } from "@/lib/openai";
import { getAnthropic, CHAT_MODEL } from "@/lib/anthropic";
import { logEnvStatus, missingEnvVars } from "@/lib/env-debug";

export const runtime = "nodejs";
export const maxDuration = 60;

const SYSTEM_PROMPT =
  "Answer using only the provided context. After your answer, list the exact source chunks you used as numbered citations.";

// How many prior messages to include as conversational context.
const HISTORY_TURNS = 10;

type Citation = {
  index: number;
  document_id: string;
  document_name: string;
  chunk_index: number;
  content: string;
  similarity: number;
};

type StoredMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: Citation[] | null;
  created_at: string;
};

type ChatBody = {
  query?: string;
  document_id?: string | null;
};

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest) {
  try {
    const missing = missingEnvVars();
    if (missing.length > 0) {
      return jsonError(`Missing env vars: ${missing.join(", ")}`, 500);
    }
    const url = new URL(request.url);
    const docParam = url.searchParams.get("document_id");
    const documentId = docParam && docParam !== "null" ? docParam : null;

    const sb = getSupabase();
    let q = sb
      .from("messages")
      .select("id, role, content, citations, created_at")
      .order("created_at", { ascending: true });
    q = documentId ? q.eq("document_id", documentId) : q.is("document_id", null);

    const { data, error } = await q;
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

    const filterDocumentId = body.document_id ?? null;
    const sb = getSupabase();

    // 1. Recall recent conversation so the LLM can answer follow-ups.
    let priorTurns: { role: "user" | "assistant"; content: string }[] = [];
    {
      let historyQ = sb
        .from("messages")
        .select("role, content")
        .order("created_at", { ascending: false })
        .limit(HISTORY_TURNS);
      historyQ = filterDocumentId
        ? historyQ.eq("document_id", filterDocumentId)
        : historyQ.is("document_id", null);
      const { data: history, error: historyErr } = await historyQ;
      if (historyErr) {
        console.warn("[chat] could not load history", historyErr.message);
      } else if (history) {
        priorTurns = history
          .reverse()
          .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));
      }
    }

    // 2. Retrieve relevant chunks for the new question.
    const queryEmbedding = await embed(query);
    const { data: rpcData, error: rpcErr } = await sb.rpc("match_chunks", {
      query_embedding: queryEmbedding as unknown as string,
      match_count: 5,
      filter_document_id: filterDocumentId,
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

    const stream = new ReadableStream({
      async start(controller) {
        const send = (obj: unknown) =>
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));

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
              await sb.from("messages").insert([
                {
                  document_id: filterDocumentId,
                  role: "user",
                  content: query,
                },
                {
                  document_id: filterDocumentId,
                  role: "assistant",
                  content: assistantText,
                  citations,
                },
              ]);
            } catch (persistErr) {
              // Don't break the client stream over a persistence failure.
              console.error("[chat] failed to persist turn", persistErr);
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

// Wipe a thread's history.
export async function DELETE(request: NextRequest) {
  try {
    const missing = missingEnvVars();
    if (missing.length > 0) {
      return jsonError(`Missing env vars: ${missing.join(", ")}`, 500);
    }
    const url = new URL(request.url);
    const docParam = url.searchParams.get("document_id");
    const documentId = docParam && docParam !== "null" ? docParam : null;

    const sb = getSupabase();
    let q = sb.from("messages").delete();
    q = documentId ? q.eq("document_id", documentId) : q.is("document_id", null);
    const { error } = await q;
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[chat.DELETE] uncaught", err);
    return jsonError(message, 500);
  }
}

export type { Citation, StoredMessage };
