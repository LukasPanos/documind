# DocMind — AI-Powered Document Intelligence Platform

DocMind is a RAG (Retrieval-Augmented Generation) web app that lets you upload PDFs and chat with them. Ask questions, get summaries, and run semantic search across your document library — with cited, traceable answers powered by a pgvector store built from scratch.

**Live demo:** https://documind-kohl-xi.vercel.app
**Stack:** Next.js 16 (App Router) · React 19 · Supabase pgvector · OpenAI Embeddings · Anthropic Claude · Tailwind CSS v4

---

## What it does

- **Upload any PDF** — pitch decks, market reports, research papers, contracts
- **Auto-summary on upload** — Claude generates a one-paragraph summary the moment a doc is indexed
- **Semantic search** — queries are embedded and matched against document chunks using cosine similarity, not keyword search
- **Cited answers** — every response shows exactly which chunk it pulled from, with document name and chunk index
- **Multi-doc or single-doc scope** — chat across your entire library or pin a conversation to one document
- **Persistent multi-conversation history** — every document (and the "All documents" scope) has its own sidebar of past chats. Start a new chat, switch between them, and pick up old threads with up to 40 turns of context.

---

## How it works

### 1. Ingestion pipeline
When a PDF is uploaded, the backend:
1. Extracts raw text using `unpdf` (a serverless-friendly pdf.js wrapper)
2. Splits the text into ~500 token chunks with 50 token overlap, snapping to paragraph and sentence boundaries
3. Embeds each chunk in batches using OpenAI `text-embedding-3-small` (1536 dimensions)
4. Stores chunks + embeddings in Supabase with `pgvector`
5. Generates an auto-summary by passing the first ~12k characters of the document to Claude

### 2. Retrieval (the RAG part)
When a user asks a question:
1. The query is embedded using the same OpenAI model
2. A cosine similarity search runs against all stored chunk embeddings via a Supabase RPC function (`match_chunks`)
3. The top 5 most relevant chunks are retrieved, optionally filtered to a single document
4. Chunks are injected into Claude's context window as grounding material, alongside the last 40 turns of conversation history
5. Claude streams a response back, citing the specific chunks it used
6. The user + assistant turns (including citations) are persisted to the conversation

### 3. Vector search engine
Rather than using a managed vector database like Pinecone or Weaviate, this project uses **Supabase with the pgvector extension** — a PostgreSQL-native vector store. This means:
- No external vector DB dependency
- Full SQL control over similarity queries
- An `ivfflat` cosine index for fast approximate nearest-neighbor search

---

## Architecture

```
User uploads PDF
      │
      ▼
POST /api/upload
  ├── unpdf            → raw text
  ├── lib/chunk.ts     → ~500 token chunks (50 token overlap)
  ├── OpenAI           → text-embedding-3-small → vector(1536) per chunk
  ├── Supabase         → insert documents row + chunks rows
  └── Claude           → one-paragraph summary, stored on the document

User asks a question
      │
      ▼
POST /api/chat
  ├── Supabase         → load (or create) the active conversation
  ├── Supabase         → fetch up to 40 prior turns for context
  ├── OpenAI           → embed the query
  ├── Supabase         → match_chunks() RPC, cosine similarity (top 5)
  ├── Claude           → answer grounded in retrieved chunks + chat history
  ├── NDJSON stream    → client renders conversation_id, citations, deltas
  └── Supabase         → persist the user + assistant turn (with citations)
```

---

## Database schema

The canonical schema lives in [`supabase/schema.sql`](./supabase/schema.sql). Condensed:

```sql
create extension if not exists vector;
create extension if not exists "pgcrypto";

create table documents (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  summary     text,
  created_at  timestamptz default now()
);

create table chunks (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid references documents(id) on delete cascade,
  content      text not null,
  embedding    vector(1536) not null,
  chunk_index  int not null
);

create index on chunks using ivfflat (embedding vector_cosine_ops);

-- Many conversations per document (and per "All documents" scope where
-- document_id is null). Each conversation owns an ordered list of messages.
create table conversations (
  id          uuid primary key default gen_random_uuid(),
  document_id uuid references documents(id) on delete cascade,
  title       text,
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);

create table messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid references conversations(id) on delete cascade,
  role            text check (role in ('user', 'assistant')),
  content         text not null,
  citations       jsonb,
  created_at      timestamptz default now()
);

-- Cosine similarity RPC, optionally scoped to one document.
create function match_chunks(
  query_embedding    vector(1536),
  match_count        int default 5,
  filter_document_id uuid default null
) returns table (...);
```

An `AFTER INSERT` trigger on `messages` bumps `conversations.updated_at` so the sidebar sorts by most recent activity.

---

## Project layout

```
app/
  api/
    upload/route.ts            PDF → chunk → embed → store + Claude summary
    chat/route.ts              Query embed → vector search → stream Claude
    conversations/
      route.ts                 GET list of chats for a scope
      [id]/route.ts            DELETE / PATCH a chat
  upload/page.tsx              Drag-and-drop, document library w/ summaries
  chat/page.tsx                Sidebar of conversations + streaming chat UI
lib/
  chunk.ts                     Boundary-aware chunker (500 tokens, 50 overlap)
  openai.ts                    Embeddings client (text-embedding-3-small)
  anthropic.ts                 Claude client (claude-sonnet-4-20250514)
  supabase.ts                  Lazy-init Supabase client with URL validation
  env-debug.ts                 Redacted env logging for Vercel diagnostics
supabase/
  schema.sql                   Tables, indexes, RPC, trigger — idempotent
```

---

## Running locally

**1. Clone and install**
```bash
git clone https://github.com/LukasPanos/documind.git
cd documind
npm install
```

**2. Set up Supabase**
- Create a project at [supabase.com](https://supabase.com)
- Open the SQL editor and run [`supabase/schema.sql`](./supabase/schema.sql)

**3. Configure environment variables**
```bash
cp .env.local.example .env.local
```
Fill in:
```
SUPABASE_URL=https://YOUR-PROJECT.supabase.co
SUPABASE_SERVICE_ROLE_KEY=...
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
```
> `SUPABASE_URL` must be the bare project origin (no `/rest/v1`, no trailing slash). The service role key is server-only and bypasses RLS — never expose it to the browser.

**4. Run**
```bash
npm run dev
```
Visit `http://localhost:3000/upload`, drop in a PDF, then head to `/chat`.

---

## Tech decisions worth noting

| Decision | Why |
|---|---|
| pgvector over Pinecone | No external dependency, full SQL control, demonstrates understanding of how vector search actually works |
| OpenAI for embeddings, Anthropic for generation | Best-in-class embedding model paired with Claude's reasoning and instruction-following |
| `unpdf` over `pdf-parse` | Purpose-built for serverless (Vercel, Cloudflare, Deno); no pdf.js worker setup or DOM polyfills required |
| NDJSON streaming over SSE | One JSON object per line is easy to parse on the client and lets the server interleave `conversation` / `citations` / `delta` / `persist_error` events with the streamed text |
| 500 token chunks / 50 token overlap | Balances context density with retrieval precision; overlap keeps answers from falling at chunk boundaries |
| Multiple conversations per scope | A document is a body of knowledge, not a single thread — researchers want separate, named investigations |

---

## Built by

[Lukas Panos](https://github.com/LukasPanos) — founder of [Agency Copilot](https://agencycopilot.io), Computing student at Queen's University.
