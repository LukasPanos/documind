-- Migration: scope documents and conversations to a browser session.
-- Safe to run on an existing DocMind database. Run once in the Supabase
-- SQL editor. (supabase/schema.sql already includes all of this for
-- fresh installs.)

alter table documents add column if not exists session_id text;
alter table conversations add column if not exists session_id text;

create index if not exists documents_session_idx
  on documents (session_id, created_at desc);
create index if not exists conversations_session_idx
  on conversations (session_id, updated_at desc);

-- Rows predating this migration have session_id null, so they belong to no
-- session and are already invisible to every visitor. Clear them out rather
-- than waiting for the TTL sweep to age them out.
-- DESTRUCTIVE: this removes every document and chat that existed before
-- session scoping. Comment out these two statements to keep them instead.
delete from conversations where session_id is null;
delete from documents where session_id is null;

-- match_chunks gains a session filter so retrieval can never reach across
-- sessions. Adding a parameter would create an ambiguous overload, so drop
-- the old signature first.
drop function if exists match_chunks(vector, int, uuid);

create or replace function match_chunks(
  query_embedding vector(1536),
  match_count int default 5,
  filter_document_id uuid default null,
  filter_session_id text default null
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
  where (filter_document_id is null or c.document_id = filter_document_id)
    and d.session_id = filter_session_id
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- TTL sweep. Sessions end when the tab closes, so nothing is coming back
-- for rows older than the cutoff. chunks and messages cascade.
create or replace function purge_stale_sessions(older_than interval default interval '24 hours')
returns void
language sql volatile
as $$
  delete from conversations
    where updated_at < now() - older_than
      and document_id is null;
  delete from documents
    where created_at < now() - older_than;
$$;
