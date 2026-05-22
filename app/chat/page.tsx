"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type DocumentRow = {
  id: string;
  name: string;
  summary: string | null;
  created_at: string;
};

type Citation = {
  index: number;
  document_id: string;
  document_name: string;
  chunk_index: number;
  content: string;
  similarity: number;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
  streaming?: boolean;
};

const ALL_DOCS = "__all__";

function scopeParam(selected: string): string {
  return selected === ALL_DOCS ? "null" : selected;
}

export default function ChatPage() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [selected, setSelected] = useState<string>(ALL_DOCS);
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [openCitations, setOpenCitations] = useState<Record<string, boolean>>(
    {}
  );
  const scrollRef = useRef<HTMLDivElement>(null);

  // Derived: history is "loading" any time the loaded scope doesn't match.
  const loadingHistory = loadedFor !== selected;

  useEffect(() => {
    fetch("/api/upload")
      .then((r) => r.json())
      .then((j) => setDocuments(j.documents ?? []))
      .catch(() => {});
  }, []);

  // Load saved history whenever the scope changes.
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/chat?document_id=${encodeURIComponent(scopeParam(selected))}`)
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const stored: {
          id: string;
          role: "user" | "assistant";
          content: string;
          citations: Citation[] | null;
        }[] = j.messages ?? [];
        setMessages(
          stored.map((m) => ({
            id: m.id,
            role: m.role,
            text: m.content,
            citations: m.citations ?? undefined,
          }))
        );
        setLoadedFor(selected);
      })
      .catch(() => {
        if (cancelled) return;
        setMessages([]);
        setLoadedFor(selected);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const send = useCallback(async () => {
    const query = input.trim();
    if (!query || busy) return;

    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: "user",
      text: query,
    };
    const assistantId = `a-${Date.now()}`;
    const assistantMsg: Message = {
      id: assistantId,
      role: "assistant",
      text: "",
      streaming: true,
    };

    setMessages((m) => [...m, userMsg, assistantMsg]);
    setInput("");
    setBusy(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          document_id: selected === ALL_DOCS ? null : selected,
        }),
      });

      if (!res.ok || !res.body) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error ?? `Request failed (${res.status})`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let evt: {
            type: string;
            text?: string;
            citations?: Citation[];
            error?: string;
          };
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          if (evt.type === "citations" && evt.citations) {
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantId
                  ? { ...msg, citations: evt.citations }
                  : msg
              )
            );
          } else if (evt.type === "delta" && evt.text) {
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantId
                  ? { ...msg, text: msg.text + evt.text }
                  : msg
              )
            );
          } else if (evt.type === "error") {
            throw new Error(evt.error ?? "Stream error");
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Request failed";
      setMessages((m) =>
        m.map((msg) =>
          msg.id === assistantId
            ? { ...msg, text: `⚠ ${message}`, streaming: false }
            : msg
        )
      );
    } finally {
      setMessages((m) =>
        m.map((msg) =>
          msg.id === assistantId ? { ...msg, streaming: false } : msg
        )
      );
      setBusy(false);
    }
  }, [input, busy, selected]);

  const clearThread = useCallback(async () => {
    if (busy) return;
    if (
      !confirm(
        selected === ALL_DOCS
          ? "Clear the All documents chat history?"
          : "Clear chat history for this document?"
      )
    ) {
      return;
    }
    await fetch(
      `/api/chat?document_id=${encodeURIComponent(scopeParam(selected))}`,
      { method: "DELETE" }
    ).catch(() => {});
    setMessages([]);
  }, [busy, selected]);

  const selectedName =
    selected === ALL_DOCS
      ? "All documents"
      : documents.find((d) => d.id === selected)?.name ?? "Document";

  return (
    <div className="flex-1 flex flex-col mx-auto w-full max-w-4xl px-6 py-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Chat
          </h1>
          <p className="text-xs text-zinc-500 mt-0.5">
            Saved thread · {selectedName}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-xs text-zinc-500 uppercase tracking-wider">
            Scope
          </label>
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            className="bg-zinc-900 border border-zinc-800 rounded-md text-sm px-3 py-1.5 text-zinc-200 focus:outline-none focus:border-zinc-600"
          >
            <option value={ALL_DOCS}>All documents</option>
            {documents.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={clearThread}
            disabled={busy || messages.length === 0}
            className="text-xs px-2.5 py-1.5 rounded-md border border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            title="Clear this thread's history"
          >
            Clear
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950/40 p-6 min-h-[60vh]"
      >
        {loadingHistory ? (
          <div className="h-full flex items-center justify-center text-zinc-600 text-sm">
            Loading history…
          </div>
        ) : messages.length === 0 ? (
          <div className="h-full flex items-center justify-center text-zinc-500 text-sm">
            No messages yet. Ask a question to start this thread.
          </div>
        ) : (
          <div className="space-y-6">
            {messages.map((m) => (
              <MessageBubble
                key={m.id}
                message={m}
                expanded={!!openCitations[m.id]}
                onToggle={() =>
                  setOpenCitations((s) => ({ ...s, [m.id]: !s[m.id] }))
                }
              />
            ))}
          </div>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
        className="mt-4 flex gap-2"
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={
            documents.length
              ? "Ask anything about your documents…"
              : "Upload a document first, then ask away."
          }
          className="flex-1 bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-600"
          disabled={busy}
        />
        <button
          type="submit"
          disabled={busy || !input.trim()}
          className="px-5 py-3 rounded-lg bg-white text-black font-medium disabled:opacity-40 disabled:cursor-not-allowed hover:bg-zinc-200 transition-colors"
        >
          {busy ? "…" : "Send"}
        </button>
      </form>
    </div>
  );
}

function MessageBubble({
  message,
  expanded,
  onToggle,
}: {
  message: Message;
  expanded: boolean;
  onToggle: () => void;
}) {
  const isUser = message.role === "user";

  return (
    <div className={isUser ? "flex justify-end" : ""}>
      <div
        className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
          isUser
            ? "bg-indigo-500/15 border border-indigo-500/30 text-zinc-100"
            : "bg-zinc-900/80 border border-zinc-800 text-zinc-100"
        }`}
      >
        {message.text || (message.streaming ? <Cursor /> : null)}
        {!isUser && message.citations && message.citations.length > 0 && (
          <div className="mt-3 pt-3 border-t border-zinc-800">
            <button
              onClick={onToggle}
              className="text-xs text-zinc-400 hover:text-zinc-200 inline-flex items-center gap-1"
            >
              <span>
                {expanded ? "Hide" : "Show"} sources ({message.citations.length})
              </span>
              <svg
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ transform: expanded ? "rotate(180deg)" : "none" }}
              >
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            {expanded && (
              <ol className="mt-3 space-y-2">
                {message.citations.map((c) => (
                  <li
                    key={c.index}
                    className="rounded-md border border-zinc-800 bg-zinc-950/60 p-3 text-xs"
                  >
                    <div className="flex items-center justify-between text-zinc-400">
                      <span className="font-medium text-zinc-200">
                        [{c.index}] {c.document_name}
                      </span>
                      <span>
                        chunk {c.chunk_index} · {(c.similarity * 100).toFixed(0)}
                        % match
                      </span>
                    </div>
                    <p className="mt-1.5 text-zinc-400 line-clamp-4">
                      {c.content}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Cursor() {
  return (
    <span className="inline-block h-3 w-1.5 bg-zinc-400 align-middle animate-pulse" />
  );
}
