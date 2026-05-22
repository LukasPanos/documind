import { NextResponse, type NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { missingEnvVars } from "@/lib/env-debug";

export const runtime = "nodejs";

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function DELETE(
  _request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const missing = missingEnvVars();
    if (missing.length > 0) {
      return jsonError(`Missing env vars: ${missing.join(", ")}`, 500);
    }
    const { id } = await ctx.params;
    const sb = getSupabase();
    const { error } = await sb.from("conversations").delete().eq("id", id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[conversations.DELETE] uncaught", err);
    return jsonError(message, 500);
  }
}

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  try {
    const missing = missingEnvVars();
    if (missing.length > 0) {
      return jsonError(`Missing env vars: ${missing.join(", ")}`, 500);
    }
    const { id } = await ctx.params;

    let body: { title?: string };
    try {
      body = (await request.json()) as { title?: string };
    } catch {
      return jsonError("Invalid JSON body.", 400);
    }
    const title = body.title?.trim();
    if (!title) return jsonError("Missing 'title'.", 400);

    const sb = getSupabase();
    const { error } = await sb
      .from("conversations")
      .update({ title })
      .eq("id", id);
    if (error) return jsonError(error.message, 500);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[conversations.PATCH] uncaught", err);
    return jsonError(message, 500);
  }
}
