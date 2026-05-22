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

type Conversation = {
  id: string;
  document_id: string | null;
  title: string | null;
  created_at: string;
  updated_at: string;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
  streaming?: boolean;
};

const ALL_DOCS = "__all__";

function scopeMatches(conv: Conversation, selected: string): boolean {
  return selected === ALL_DOCS
    ? conv.document_id === null
    : conv.document_id === selected;
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(iso).toLocaleDateString();
}

export default function ChatPage() {
  const [documents, setDocuments] = useState<DocumentRow[]>([]);
  const [selected, setSelected] = useState<string>(ALL_DOCS);

  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadedConvsFor, setLoadedConvsFor] = useState<string | null>(null);

  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadedMessagesFor, setLoadedMessagesFor] = useState<string | null>(
    null
  );
  const [busy, setBusy] = useState(false);

  const [historyError, setHistoryError] = useState<string | null>(null);
  const [persistError, setPersistError] = useState<string | null>(null);

  const [openCitations, setOpenCitations] = useState<Record<string, boolean>>(
    {}
  );

  const scrollRef = useRef<HTMLDivElement>(null);

  const loadingConvs = loadedConvsFor !== selected;
  const loadingMessages =
    activeId !== null && loadedMessagesFor !== activeId;

  // Fetch document library once.
  useEffect(() => {
    fetch("/api/upload")
      .then((r) => r.json())
      .then((j) => setDocuments(j.documents ?? []))
      .catch(() => {});
  }, []);

  // Refetch conversation list whenever scope changes.
  useEffect(() => {
    let cancelled = false;
    const docParam = selected === ALL_DOCS ? "null" : selected;
    fetch(`/api/conversations?document_id=${encodeURIComponent(docParam)}`)
      .then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json() }))
      .then(({ ok, status, body }) => {
        if (cancelled) return;
        if (!ok || body.error) {
          const msg = body.error ?? `Failed to load chats (${status})`;
          const hint =
            /relation .* does not exist|conversations.*does not exist|messages.*does not exist/i.test(
              msg
            )
              ? " — rerun supabase/schema.sql so the conversations table exists."
              : "";
          setHistoryError(msg + hint);
          setConversations([]);
          setActiveId(null);
          setMessages([]);
          setLoadedConvsFor(selected);
          setLoadedMessagesFor(null);
          return;
        }
        setHistoryError(null);
        const convs: Conversation[] = body.conversations ?? [];
        setConversations(convs);
        // Default: pick the most recent existing chat for this scope.
        const next = convs[0]?.id ?? null;
        setActiveId(next);
        if (next === null) {
          setMessages([]);
          setLoadedMessagesFor(null);
        }
        setLoadedConvsFor(selected);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setHistoryError(
          err instanceof Error ? err.message : "Failed to load chats"
        );
        setConversations([]);
        setActiveId(null);
        setMessages([]);
        setLoadedConvsFor(selected);
        setLoadedMessagesFor(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // Load messages for whichever conversation is active. Skips when the
  // active id is a freshly-streamed one (already in state) or null.
  useEffect(() => {
    if (activeId === null) return;
    if (loadedMessagesFor === activeId) return;
    let cancelled = false;
    fetch(`/api/chat?conversation_id=${encodeURIComponent(activeId)}`)
      .then(async (r) => ({ ok: r.ok, status: r.status, body: await r.json() }))
      .then(({ ok, status, body }) => {
        if (cancelled) return;
        if (!ok || body.error) {
          const msg = body.error ?? `Failed to load messages (${status})`;
          setHistoryError(msg);
          setMessages([]);
          setLoadedMessagesFor(activeId);
          return;
        }
        const stored: {
          id: string;
          role: "user" | "assistant";
          content: string;
          citations: Citation[] | null;
        }[] = body.messages ?? [];
        setMessages(
          stored.map((m) => ({
            id: m.id,
            role: m.role,
            text: m.content,
            citations: m.citations ?? undefined,
          }))
        );
        setLoadedMessagesFor(activeId);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setHistoryError(
          err instanceof Error ? err.message : "Failed to load messages"
        );
        setMessages([]);
        setLoadedMessagesFor(activeId);
      });
    return () => {
      cancelled = true;
    };
  }, [activeId, loadedMessagesFor]);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  const startNewChat = useCallback(() => {
    if (busy) return;
    setActiveId(null);
    setMessages([]);
    setLoadedMessagesFor(null);
    setPersistError(null);
  }, [busy]);

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
    setPersistError(null);

    let receivedConvId: string | null = null;

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query,
          conversation_id: activeId,
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
            conversation_id?: string;
            error?: string;
          };
          try {
            evt = JSON.parse(line);
          } catch {
            continue;
          }
          if (evt.type === "conversation" && evt.conversation_id) {
            receivedConvId = evt.conversation_id;
          } else if (evt.type === "citations" && evt.citations) {
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
          } else if (evt.type === "persist_error") {
            setPersistError(evt.error ?? "Failed to save this turn");
          } else if (evt.type === "error") {
            throw new Error(evt.error ?? "Stream error");
          }
        }
      }

      // If the server created a new conversation for this turn, update
      // local state and refresh the sidebar list.
      if (receivedConvId && receivedConvId !== activeId) {
        setActiveId(receivedConvId);
        // The messages we just streamed are already in state; mark them
        // as loaded for this id so the effect doesn't refetch and clobber.
        setLoadedMessagesFor(receivedConvId);
        // Refresh the conversation list to include the new one.
        const docParam = selected === ALL_DOCS ? "null" : selected;
        fetch(`/api/conversations?document_id=${encodeURIComponent(docParam)}`)
          .then((r) => r.json())
          .then((j) => setConversations(j.conversations ?? []))
          .catch(() => {});
      } else if (receivedConvId) {
        // Bump this conversation to the top of the list (it was just used).
        setConversations((cs) => {
          const me = cs.find((c) => c.id === receivedConvId);
          if (!me) return cs;
          const rest = cs.filter((c) => c.id !== receivedConvId);
          return [
            { ...me, updated_at: new Date().toISOString() },
            ...rest,
          ];
        });
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
  }, [input, busy, selected, activeId]);

  const deleteConversation = useCallback(
    async (id: string) => {
      if (!confirm("Delete this chat? This cannot be undone.")) return;
      const res = await fetch(`/api/conversations/${id}`, {
        method: "DELETE",
      }).catch(() => null);
      if (!res || !res.ok) {
        const errJson = await res?.json().catch(() => ({}));
        setHistoryError(errJson?.error ?? "Failed to delete chat");
        return;
      }
      setConversations((cs) => cs.filter((c) => c.id !== id));
      if (id === activeId) {
        const remaining = conversations.filter((c) => c.id !== id);
        const next = remaining[0]?.id ?? null;
        setActiveId(next);
        if (next === null) {
          setMessages([]);
          setLoadedMessagesFor(null);
        } else {
          setLoadedMessagesFor(null);
        }
      }
    },
    [activeId, conversations]
  );

  const selectedName =
    selected === ALL_DOCS
      ? "All documents"
      : documents.find((d) => d.id === selected)?.name ?? "Document";

  const visibleConversations = conversations.filter((c) =>
    scopeMatches(c, selected)
  );

  return (
    <div className="flex-1 flex flex-col mx-auto w-full max-w-6xl px-6 py-6">
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-white">
            Chat
          </h1>
          <p className="text-xs text-zinc-500 mt-0.5">{selectedName}</p>
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
        </div>
      </div>

      {(historyError || persistError) && (
        <div className="mb-3 rounded-md border border-amber-900/60 bg-amber-950/40 text-amber-200 text-sm px-3 py-2">
          {historyError && <div>History: {historyError}</div>}
          {persistError && <div>Save: {persistError}</div>}
        </div>
      )}

      <div className="flex-1 grid grid-cols-1 md:grid-cols-[260px_1fr] gap-4 min-h-[60vh]">
        {/* Sidebar: past conversations for this scope */}
        <aside className="rounded-xl border border-zinc-800 bg-zinc-950/40 flex flex-col overflow-hidden">
          <button
            type="button"
            onClick={startNewChat}
            disabled={busy}
            className="m-2 inline-flex items-center justify-center gap-2 h-9 rounded-md bg-white text-black text-sm font-medium hover:bg-zinc-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <span className="text-base leading-none">+</span> New chat
          </button>
          <div className="px-3 pb-2 text-xs uppercase tracking-wider text-zinc-500">
            Past chats
          </div>
          <ul className="flex-1 overflow-y-auto px-2 pb-2 space-y-1">
            {loadingConvs ? (
              <li className="px-2 py-2 text-xs text-zinc-600">Loading…</li>
            ) : visibleConversations.length === 0 ? (
              <li className="px-2 py-2 text-xs text-zinc-600">
                No past chats yet.
              </li>
            ) : (
              visibleConversations.map((c) => {
                const isActive = c.id === activeId;
                return (
                  <li key={c.id}>
                    <div
                      className={`group rounded-md px-2 py-2 cursor-pointer transition-colors ${
                        isActive
                          ? "bg-zinc-800/80"
                          : "hover:bg-zinc-900/80"
                      }`}
                      onClick={() => {
                        if (busy || c.id === activeId) return;
                        setActiveId(c.id);
                      }}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-sm text-zinc-100 truncate">
                            {c.title || "Untitled chat"}
                          </div>
                          <div className="text-[10px] text-zinc-500 mt-0.5">
                            {relativeTime(c.updated_at)}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteConversation(c.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 text-zinc-500 hover:text-red-400 text-xs px-1 shrink-0"
                          aria-label="Delete chat"
                          title="Delete chat"
                        >
                          ✕
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })
            )}
          </ul>
        </aside>

        {/* Messages */}
        <div className="flex flex-col min-h-[60vh]">
          <div
            ref={scrollRef}
            className="flex-1 overflow-y-auto rounded-xl border border-zinc-800 bg-zinc-950/40 p-6"
          >
            {loadingMessages ? (
              <div className="h-full flex items-center justify-center text-zinc-600 text-sm">
                Loading messages…
              </div>
            ) : messages.length === 0 ? (
              <div className="h-full flex items-center justify-center text-zinc-500 text-sm">
                {activeId === null
                  ? "Ask a question to start a new chat."
                  : "No messages yet."}
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
      </div>
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
