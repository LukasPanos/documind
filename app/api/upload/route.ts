import { NextResponse, type NextRequest } from "next/server";
import { PDFParse } from "pdf-parse";
import { getSupabase } from "@/lib/supabase";
import { embedBatch } from "@/lib/openai";
import { getAnthropic, CHAT_MODEL } from "@/lib/anthropic";
import { chunkText } from "@/lib/chunk";
import { logEnvStatus, missingEnvVars } from "@/lib/env-debug";

export const runtime = "nodejs";
export const maxDuration = 60;

function jsonError(message: string, status: number, detail?: unknown) {
  console.error(`[upload] ${status} — ${message}`, detail ?? "");
  return NextResponse.json(
    detail !== undefined ? { error: message, detail: String(detail) } : { error: message },
    { status }
  );
}

async function summarize(name: string, text: string): Promise<string> {
  const excerpt = text.slice(0, 12000);
  const msg = await getAnthropic().messages.create({
    model: CHAT_MODEL,
    max_tokens: 400,
    system:
      "You write tight, useful one-paragraph summaries of documents for a research analyst. " +
      "Lead with what the document is and who it's for, then the key findings or claims. " +
      "Plain prose, 3-5 sentences, no preamble like 'This document'.",
    messages: [
      { role: "user", content: `Document filename: ${name}\n\n---\n\n${excerpt}` },
    ],
  });
  const block = msg.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}

export async function POST(request: NextRequest) {
  const startedAt = Date.now();
  logEnvStatus("upload.POST");

  try {
    const missing = missingEnvVars();
    if (missing.length > 0) {
      return jsonError(
        `Server is missing required environment variables: ${missing.join(", ")}. ` +
          `Set them in Vercel → Project → Settings → Environment Variables and redeploy.`,
        500
      );
    }

    let formData: FormData;
    try {
      formData = await request.formData();
    } catch (err) {
      return jsonError(
        "Failed to read upload body. The file may exceed Vercel's request body limit (4.5MB on Hobby).",
        413,
        err instanceof Error ? err.message : err
      );
    }

    const file = formData.get("file");
    if (!(file instanceof File)) {
      return jsonError("No file provided. Expected multipart field 'file'.", 400);
    }
    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return jsonError("Only PDF files are supported.", 400);
    }

    console.log("[upload] file received", {
      name: file.name,
      type: file.type,
      size_bytes: file.size,
    });

    let text: string;
    try {
      const buffer = Buffer.from(await file.arrayBuffer());
      const parser = new PDFParse({ data: buffer });
      const result = await parser.getText();
      await parser.destroy();
      text = result.text;
      console.log("[upload] pdf parsed", { chars: text?.length ?? 0 });
    } catch (err) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const stack = err instanceof Error ? err.stack : undefined;
      console.error("[upload] pdf parse failure", { detail, stack });
      return jsonError("Failed to parse PDF.", 422, detail);
    }

    if (!text || text.trim().length < 20) {
      return jsonError(
        "Could not extract usable text from this PDF (it may be scanned/image-only).",
        422
      );
    }

    const chunks = chunkText(text);
    console.log("[upload] chunked", { count: chunks.length });
    if (chunks.length === 0) {
      return jsonError("PDF produced no usable chunks.", 422);
    }

    let embeddings: number[][];
    try {
      embeddings = [];
      const BATCH = 64;
      for (let i = 0; i < chunks.length; i += BATCH) {
        const slice = chunks.slice(i, i + BATCH);
        const vectors = await embedBatch(slice);
        embeddings.push(...vectors);
      }
      console.log("[upload] embedded", { count: embeddings.length });
    } catch (err) {
      return jsonError(
        "OpenAI embedding request failed.",
        502,
        err instanceof Error ? err.message : err
      );
    }

    let summary = "";
    try {
      summary = await summarize(file.name, text);
      console.log("[upload] summarized", { chars: summary.length });
    } catch (err) {
      console.warn("[upload] summary failed, continuing without it", err);
    }

    const supabase = getSupabase();

    const { data: doc, error: docErr } = await supabase
      .from("documents")
      .insert({ name: file.name, summary })
      .select("id, name, summary, created_at")
      .single();

    if (docErr || !doc) {
      return jsonError("Failed to create document row.", 500, docErr?.message);
    }
    console.log("[upload] document inserted", { id: doc.id });

    const rows = chunks.map((content, idx) => ({
      document_id: doc.id,
      content,
      embedding: embeddings[idx] as unknown as string,
      chunk_index: idx,
    }));

    const { error: chunkErr } = await supabase.from("chunks").insert(rows);
    if (chunkErr) {
      await supabase.from("documents").delete().eq("id", doc.id);
      return jsonError("Failed to store chunks.", 500, chunkErr.message);
    }

    console.log("[upload] done", {
      doc_id: doc.id,
      chunks: chunks.length,
      ms: Date.now() - startedAt,
    });

    return NextResponse.json({ document: doc, chunk_count: chunks.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    const stack = err instanceof Error ? err.stack : undefined;
    console.error("[upload] uncaught", { message, stack });
    return NextResponse.json(
      { error: `Upload crashed: ${message}` },
      { status: 500 }
    );
  }
}

export async function GET() {
  try {
    const missing = missingEnvVars();
    if (missing.length > 0) {
      return NextResponse.json(
        { error: `Missing env vars: ${missing.join(", ")}` },
        { status: 500 }
      );
    }
    const { data, error } = await getSupabase()
      .from("documents")
      .select("id, name, summary, created_at")
      .order("created_at", { ascending: false });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({ documents: data ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[upload.GET] uncaught", err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
