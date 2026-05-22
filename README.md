# DocMind — AI-Powered Document Intelligence Platform

DocMind is a RAG (Retrieval-Augmented Generation) web app that lets you upload PDFs and chat with them. Ask questions, get summaries, and run semantic search across your document library — with cited, traceable answers powered by a vector search engine built from scratch.

**Live demo:** [documind-kohl-xi.vercel.app/]  
**Stack:** Next.js 14 · Supabase pgvector · OpenAI Embeddings · Anthropic Claude · Tailwind CSS

---

## What it does

- **Upload any PDF** — pitch decks, market reports, research papers, contracts
- **Auto-summary on upload** — Claude generates a one-paragraph summary the moment a doc is indexed
- **Semantic search** — queries are embedded and matched against document chunks using cosine similarity, not keyword search
- **Cited answers** — every response shows exactly which chunk it pulled from, with document name and chunk index
- **Multi-doc or single-doc scope** — chat across your entire library or pin a conversation to one document

---

## How it works

### 1. Ingestion pipeline
When a PDF is uploaded, the backend:
1. Extracts raw text using `pdf-parse`
2. Splits the text into ~500 token chunks with 50 token overlap (preserving sentence boundaries)
3. Embeds each chunk using OpenAI `text-embedding-3-small` (1536 dimensions)
4. Stores chunks + embeddings in Supabase with `pgvector`
5. Generates an auto-summary by passing the full text to Claude

### 2. Retrieval (the RAG part)
When a user asks a question:
1. The query is embedded using the same OpenAI model
2. A cosine similarity search runs against all stored chunk embeddings via a Supabase RPC function (`match_chunks`)
3. The top 5 most relevant chunks are retrieved
4. Chunks are injected into Claude's context window as grounding material
5. Claude streams a response back, citing the specific chunks it used

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
/api/upload
  ├── pdf-parse → raw text
  ├── chunk.ts → ~500 token chunks (50 token overlap)
  ├── OpenAI text-embedding-3-small → vector[1536] per chunk
  ├── Supabase → insert into documents + chunks tables
  └── Claude claude-sonnet-4-20250514 → auto-summary stored on document

User asks a question
      │
      ▼
/api/chat
  ├── OpenAI → embed the query
  ├── Supabase match_chunks() RPC → cosine similarity search (top 5)
  ├── Claude claude-sonnet-4-20250514 → answer grounded in retrieved chunks
  └── NDJSON stream → client renders text + citations in real time
```

---

## Database schema

```sql
-- pgvector extension
CREATE EXTENSION IF NOT EXISTS vector;

-- Documents table
CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  summary TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Chunks table with vector embeddings
CREATE TABLE chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID REFERENCES documents(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  embedding vector(1536),
  chunk_index INT
);

-- IVFFlat index for fast cosine similarity search
CREATE INDEX ON chunks USING ivfflat (embedding vector_cosine_ops);

-- RPC function for similarity search
CREATE OR REPLACE FUNCTION match_chunks(
  query_embedding vector(1536),
  match_count INT,
  filter_document_id UUID DEFAULT NULL
)
RETURNS TABLE (id UUID, document_id UUID, content TEXT, chunk_index INT, similarity FLOAT)
...
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
- Run `supabase/schema.sql` in the SQL editor

**3. Configure environment variables**
```bash
cp .env.local.example .env.local
```
Fill in:
```
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
```

**4. Run**
```bash
npm run dev
```
Visit `http://localhost:3000/upload`

---

## Tech decisions worth noting

| Decision | Why |
|---|---|
| pgvector over Pinecone | No external dependency, full SQL control, demonstrates understanding of how vector search actually works |
| OpenAI for embeddings, Anthropic for generation | Best-in-class embedding model paired with Claude's superior reasoning and instruction-following |
| NDJSON streaming over SSE | Simpler to parse on the client while still enabling real-time citations interleaved with text |
| 500 token chunks / 50 token overlap | Balances context density with retrieval precision; overlap prevents answers from falling at chunk boundaries |

---

## Built by

[Lukas Panos](https://github.com/LukasPanos) — founder of [Agency Copilot](https://agencycopilot.io), Computing student at Queen's University.
