"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type DocumentRow = {
  id: string;
  name: string;
  summary: string | null;
  created_at: string;
};

export default function UploadPage() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [loadingLibrary, setLoadingLibrary] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/upload", { method: "GET" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load library");
      setDocuments(json.documents ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load library");
    } finally {
      setLoadingLibrary(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/upload")
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json.error) throw new Error(json.error);
        setDocuments(json.documents ?? []);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load library");
      })
      .finally(() => {
        if (!cancelled) setLoadingLibrary(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const upload = useCallback(
    async (file: File) => {
      setError(null);
      setStatusMessage(`Uploading ${file.name}…`);
      setUploading(true);

      try {
        const fd = new FormData();
        fd.append("file", file);

        const res = await fetch("/api/upload", { method: "POST", body: fd });
        const raw = await res.text();
        let json: {
          error?: string;
          detail?: string;
          document?: { name: string };
          chunk_count?: number;
        } = {};
        try {
          json = raw ? JSON.parse(raw) : {};
        } catch {
          throw new Error(
            `Server returned ${res.status} ${res.statusText} (non-JSON): ${raw.slice(0, 300)}`
          );
        }

        if (!res.ok) {
          const msg = json.error ?? `Upload failed (${res.status})`;
          throw new Error(json.detail ? `${msg} — ${json.detail}` : msg);
        }

        setStatusMessage(
          `Added ${json.document?.name ?? file.name} (${json.chunk_count} chunks indexed).`
        );
        await refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
        setStatusMessage(null);
      } finally {
        setUploading(false);
      }
    },
    [refresh]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files?.[0];
      if (file) upload(file);
    },
    [upload]
  );

  return (
    <div className="mx-auto w-full max-w-4xl px-6 py-12">
      <div className="mb-10">
        <h1 className="text-3xl font-semibold tracking-tight text-white">
          Upload documents
        </h1>
        <p className="mt-2 text-zinc-400">
          Drop a PDF to extract, chunk, embed, and index it. We&apos;ll
          auto-write a summary too.
        </p>
      </div>

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-2xl border-2 border-dashed p-12 text-center transition-colors ${
          dragOver
            ? "border-indigo-400 bg-indigo-500/5"
            : "border-zinc-800 hover:border-zinc-700 bg-zinc-950/40"
        } ${uploading ? "opacity-60 pointer-events-none" : ""}`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) upload(file);
            e.target.value = "";
          }}
        />
        <div className="mx-auto h-12 w-12 rounded-full bg-zinc-900 flex items-center justify-center mb-4">
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="text-zinc-400"
          >
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
        </div>
        <p className="text-zinc-200 font-medium">
          {uploading ? "Indexing…" : "Drop a PDF or click to browse"}
        </p>
        <p className="text-zinc-500 text-sm mt-1">
          Pitch decks, market reports, research papers, contracts.
        </p>
      </div>

      {statusMessage && !error && (
        <div className="mt-4 rounded-md border border-emerald-900/60 bg-emerald-950/40 text-emerald-300 text-sm px-4 py-2.5">
          {statusMessage}
        </div>
      )}
      {error && (
        <div className="mt-4 rounded-md border border-red-900/60 bg-red-950/40 text-red-300 text-sm px-4 py-2.5">
          {error}
        </div>
      )}

      <div className="mt-14">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-lg font-semibold text-white">Library</h2>
          <span className="text-xs text-zinc-500">
            {documents.length} document{documents.length === 1 ? "" : "s"}
          </span>
        </div>

        {loadingLibrary ? (
          <p className="text-zinc-500 text-sm">Loading…</p>
        ) : documents.length === 0 ? (
          <p className="text-zinc-500 text-sm">
            No documents yet. Upload one above to get started.
          </p>
        ) : (
          <ul className="space-y-3">
            {documents.map((d) => (
              <li
                key={d.id}
                className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-5"
              >
                <div className="flex items-start justify-between gap-4">
                  <h3 className="text-white font-medium truncate">{d.name}</h3>
                  <span className="text-xs text-zinc-500 shrink-0">
                    {new Date(d.created_at).toLocaleDateString()}
                  </span>
                </div>
                {d.summary && (
                  <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                    {d.summary}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
