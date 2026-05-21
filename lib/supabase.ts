import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !serviceKey) {
  throw new Error(
    "Missing Supabase env vars. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local"
  );
}

export const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false },
});

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
