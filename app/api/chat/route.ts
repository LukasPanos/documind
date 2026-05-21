import { NextResponse, type NextRequest } from "next/server";
import { getSupabase, type MatchedChunk } from "@/lib/supabase";
import { embed } from "@/lib/openai";
import { getAnthropic, CHAT_MODEL } from "@/lib/anthropic";
import { logEnvStatus, missingEnvVars } from "@/lib/env-debug";

export const runtime = "nodejs";
export const maxDuration = 60;

const SYSTEM_PROMPT =
  "Answer using only the provided context. After your answer, list the exact source chunks you used as numbered citations.";

type ChatBody = {
  query?: string;
  document_id?: string | null;
};

export async function POST(request: NextRequest) {
  logEnvStatus("chat.POST");

  try {
    const missing = missingEnvVars();
    if (missing.length > 0) {
      return NextResponse.json(
        {
          error:
            `Server is missing required environment variables: ${missing.join(", ")}. ` +
            `Set them in Vercel → Project → Settings → Environment Variables and redeploy.`,
        },
        { status: 500 }
      );
    }

    let body: ChatBody;
    try {
      body = (await request.json()) as ChatBody;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const query = body.query?.trim();
    if (!query) {
      return NextResponse.json({ error: "Missing 'query'." }, { status: 400 });
    }

    const filterDocumentId = body.document_id ?? null;

    const queryEmbedding = await embed(query);

    const { data, error } = await getSupabase().rpc("match_chunks", {
      query_embedding: queryEmbedding as unknown as string,
      match_count: 5,
      filter_document_id: filterDocumentId,
    });

    if (error) {
      console.error("[chat] match_chunks failed", error);
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    const matches = (data ?? []) as MatchedChunk[];

    const citations = matches.map((m, i) => ({
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

        try {
          const llmStream = anthropic.messages.stream({
            model: CHAT_MODEL,
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            messages: [{ role: "user", content: userMessage }],
          });

          for await (const event of llmStream) {
            if (
              event.type === "content_block_delta" &&
              event.delta.type === "text_delta"
            ) {
              send({ type: "delta", text: event.delta.text });
            }
          }

          send({ type: "done" });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Stream error";
          console.error("[chat] stream error", err);
          send({ type: "error", error: message });
        } finally {
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
    return NextResponse.json(
      { error: `Chat crashed: ${message}` },
      { status: 500 }
    );
  }
}
