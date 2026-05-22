-- DocMind Supabase schema
-- Run this in the Supabase SQL editor (or via the CLI) before using the app.

create extension if not exists vector;
create extension if not exists "pgcrypto";

create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  summary text,
  created_at timestamptz not null default now()
);

create table if not exists chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  content text not null,
  embedding vector(1536) not null,
  chunk_index int not null
);

create index if not exists chunks_document_id_idx on chunks (document_id);
create index if not exists chunks_embedding_idx on chunks
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- Multiple chats per document (and per "All documents" scope where
-- document_id is null). Each conversation holds an ordered list of
-- messages. Re-running this script will reset chat history because
-- the previous single-thread `messages` table is dropped.
drop table if exists messages;

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  document_id uuid references documents(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists conversations_doc_idx
  on conversations (document_id, updated_at desc);
create index if not exists conversations_all_idx
  on conversations (updated_at desc)
  where document_id is null;

create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  citations jsonb,
  created_at timestamptz not null default now()
);

create index if not exists messages_conv_idx
  on messages (conversation_id, created_at);

-- Bump conversations.updated_at whenever a message is appended so the
-- sidebar can sort by recent activity.
create or replace function touch_conversation_updated_at()
returns trigger language plpgsql as $$
begin
  update conversations
    set updated_at = now()
    where id = new.conversation_id;
  return new;
end;
$$;

drop trigger if exists messages_touch_conversation on messages;
create trigger messages_touch_conversation
  after insert on messages
  for each row execute function touch_conversation_updated_at();

-- Cosine-similarity RPC. Pass an optional document_id to restrict to a single doc.
create or replace function match_chunks(
  query_embedding vector(1536),
  match_count int default 5,
  filter_document_id uuid default null
)
returns table (
  id uuid,
  document_id uuid,
  content text,
  chunk_index int,
  similarity float,
  document_name text
)
language sql stable
as $$
  select
    c.id,
    c.document_id,
    c.content,
    c.chunk_index,
    1 - (c.embedding <=> query_embedding) as similarity,
    d.name as document_name
  from chunks c
  join documents d on d.id = c.document_id
  where filter_document_id is null or c.document_id = filter_document_id
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
