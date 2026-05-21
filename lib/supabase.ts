import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) {
    throw new Error(
      "SUPABASE_URL is not set. Add it to your Vercel project's Environment Variables."
    );
  }
  if (!serviceKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Add it to your Vercel project's Environment Variables."
    );
  }
  cached = createClient(url, serviceKey, {
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
