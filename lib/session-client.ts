import { SESSION_HEADER } from "./session";

const STORAGE_KEY = "docmind.session_id";

/**
 * Session id for this tab. sessionStorage survives a refresh but not a new
 * tab or a browser restart, which is exactly the reset behaviour we want.
 */
export function getSessionId(): string {
  if (typeof window === "undefined") return "";
  let id = window.sessionStorage.getItem(STORAGE_KEY);
  if (!id) {
    id = crypto.randomUUID();
    window.sessionStorage.setItem(STORAGE_KEY, id);
  }
  return id;
}

/** fetch() with this tab's session id attached. Use for every /api call. */
export function sessionFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set(SESSION_HEADER, getSessionId());
  return fetch(input, { ...init, headers });
}
