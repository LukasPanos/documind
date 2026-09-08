import { NextResponse, type NextRequest } from "next/server";
import { describeSupabaseError, getSupabase } from "@/lib/supabase";
import { missingEnvVars } from "@/lib/env-debug";
import { sessionIdFrom } from "@/lib/session";

export const runtime = "nodejs";

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

    const sessionId = sessionIdFrom(request);
    if (!sessionId) return NextResponse.json({ conversations: [] });

    const sb = getSupabase();
    let q = sb
      .from("conversations")
      .select("id, document_id, title, created_at, updated_at")
      .eq("session_id", sessionId)
      .order("updated_at", { ascending: false });
    q = documentId ? q.eq("document_id", documentId) : q.is("document_id", null);

    const { data, error } = await q;
    if (error) return jsonError(describeSupabaseError(error), 500);
    return NextResponse.json({ conversations: data ?? [] });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[conversations.GET] uncaught", err);
    return jsonError(message, 500);
  }
}
