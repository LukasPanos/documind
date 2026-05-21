import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

function normalizeSupabaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("SUPABASE_URL is empty.");
  }
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error(
      `SUPABASE_URL must start with https:// (got "${trimmed.slice(0, 40)}…"). ` +
        `Use your project's Project URL from Supabase → Settings → API, e.g. https://abc123.supabase.co`
    );
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`SUPABASE_URL is not a valid URL: "${trimmed.slice(0, 60)}"`);
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error(
      `SUPABASE_URL should be just the project origin, no path. ` +
        `Got pathname "${url.pathname}". Strip everything after the .supabase.co domain.`
    );
  }
  // supabase-js wants no trailing slash on the origin.
  return url.origin;
}

export function getSupabase(): SupabaseClient {
  if (cached) return cached;
  const rawUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!rawUrl) {
    throw new Error(
      "SUPABASE_URL is not set. Add it to your Vercel project's Environment Variables."
    );
  }
  if (!serviceKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Add it to your Vercel project's Environment Variables."
    );
  }
  const url = normalizeSupabaseUrl(rawUrl);
  console.log("[supabase] using url", { url, raw_length: rawUrl.length });
  cached = createClient(url, serviceKey.trim(), {
    auth: { persistSession: false },
  });
  return cached;
}

export type DocumentRow = {
  id: string;
  name: string;
  summary: string | null;
  created_at: string;
};

export type ChunkRow = {
  id: string;
  document_id: string;
  content: string;
  chunk_index: number;
};

export type MatchedChunk = ChunkRow & {
  similarity: number;
  document_name: string;
};
