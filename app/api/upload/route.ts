import { NextResponse, type NextRequest } from "next/server";
import { PDFParse } from "pdf-parse";
import { supabase } from "@/lib/supabase";
import { embedBatch } from "@/lib/openai";
import { anthropic, CHAT_MODEL } from "@/lib/anthropic";
import { chunkText } from "@/lib/chunk";

export const runtime = "nodejs";
export const maxDuration = 60;

async function summarize(name: string, text: string): Promise<string> {
  const excerpt = text.slice(0, 12000);
  const msg = await anthropic.messages.create({
    model: CHAT_MODEL,
    max_tokens: 400,
    system:
      "You write tight, useful one-paragraph summaries of documents for a research analyst. " +
      "Lead with what the document is and who it's for, then the key findings or claims. " +
      "Plain prose, 3-5 sentences, no preamble like 'This document'.",
    messages: [
      {
        role: "user",
        content: `Document filename: ${name}\n\n---\n\n${excerpt}`,
      },
    ],
  });
  const block = msg.content.find((b) => b.type === "text");
  return block && block.type === "text" ? block.text.trim() : "";
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { error: "No file provided. Expected multipart field 'file'." },
        { status: 400 }
      );
    }

    if (!file.name.toLowerCase().endsWith(".pdf")) {
      return NextResponse.json(
        { error: "Only PDF files are supported." },
        { status: 400 }
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    const parser = new PDFParse({ data: buffer });
    const { text } = await parser.getText();
    await parser.destroy();

    if (!text || text.trim().length < 20) {
      return NextResponse.json(
        { error: "Could not extract text from this PDF." },
        { status: 422 }
      );
    }

    const chunks = chunkText(text);
    if (chunks.length === 0) {
      return NextResponse.json(
        { error: "PDF produced no usable chunks." },
        { status: 422 }
      );
    }

    const embeddings: number[][] = [];
    const BATCH = 64;
    for (let i = 0; i < chunks.length; i += BATCH) {
      const slice = chunks.slice(i, i + BATCH);
      const vectors = await embedBatch(slice);
      embeddings.push(...vectors);
    }

    const summary = await summarize(file.name, text);

    const { data: doc, error: docErr } = await supabase
      .from("documents")
      .insert({ name: file.name, summary })
      .select("id, name, summary, created_at")
      .single();

    if (docErr || !doc) {
      return NextResponse.json(
        { error: `Failed to create document: ${docErr?.message ?? "unknown"}` },
        { status: 500 }
      );
    }

    const rows = chunks.map((content, idx) => ({
      document_id: doc.id,
      content,
      embedding: embeddings[idx] as unknown as string,
      chunk_index: idx,
    }));

    const { error: chunkErr } = await supabase.from("chunks").insert(rows);

    if (chunkErr) {
      await supabase.from("documents").delete().eq("id", doc.id);
      return NextResponse.json(
        { error: `Failed to store chunks: ${chunkErr.message}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      document: doc,
      chunk_count: chunks.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function GET() {
  const { data, error } = await supabase
    .from("documents")
    .select("id, name, summary, created_at")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ documents: data ?? [] });
}
