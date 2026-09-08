import type { NextRequest } from "next/server";

/**
 * Every request carries the browser session that owns the data it touches.
 * Documents and conversations are scoped to this value, so a new tab starts
 * with an empty library and no chat history.
 */
export const SESSION_HEADER = "x-session-id";

/** Reads the caller's session id, or null when the header is absent/blank. */
export function sessionIdFrom(request: NextRequest): string | null {
  const raw = request.headers.get(SESSION_HEADER)?.trim();
  return raw ? raw : null;
}
