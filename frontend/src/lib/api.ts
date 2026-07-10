export class ApiError extends Error {
  code: string;
  constructor(code: string, msg: string) {
    super(msg);
    this.code = code;
  }
}

// Access token lives in memory only — never localStorage/sessionStorage (XSS blast-radius rule).
let accessToken: string | null = null;
let refreshInFlight: Promise<string | null> | null = null;

export function setAccessToken(token: string | null) {
  accessToken = token;
}

export function getAccessToken(): string | null {
  return accessToken;
}

async function refreshAccessToken(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch("/api/v1/auth/refresh", { method: "POST", credentials: "include" });
        const envelope = await res.json();
        if (envelope.code !== "OK") return null;
        const token = envelope.data.accessToken as string;
        setAccessToken(token);
        return token;
      } catch {
        return null;
      } finally {
        refreshInFlight = null;
      }
    })();
  }
  return refreshInFlight;
}

type ApiOptions = {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  /** Set false for boot-time auth checks — "not logged in" is expected, not a redirect trigger. */
  redirectOnAuthFailure?: boolean;
};

async function request<T>(path: string, opts: ApiOptions, isRetry: boolean): Promise<T> {
  const tokenAtStart = accessToken;
  const headers: Record<string, string> = { "Content-Type": "application/json", ...opts.headers };
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;

  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    credentials: "include",
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const envelope = await res.json();

  if (envelope.code === "OK") return envelope.data as T;

  if (!isRetry && (envelope.code === "EXPIRED_ACCESS_TOKEN" || envelope.code === "INVALID_ACCESS_TOKEN")) {
    // A newer token may have been installed while this request (or a doomed pre-login refresh)
    // was in flight — the magic-link verify finishing during the app-boot auth dance does
    // exactly this. Retry with the new token, and never let the stale failure clobber it.
    if (accessToken && accessToken !== tokenAtStart) {
      return request<T>(path, opts, true);
    }
    const refreshed = await refreshAccessToken();
    if (refreshed) return request<T>(path, opts, true);
    if (accessToken === tokenAtStart) setAccessToken(null);
    if (opts.redirectOnAuthFailure !== false && typeof window !== "undefined") {
      window.location.assign("/login");
    }
  }

  throw new ApiError(envelope.code, envelope.msg);
}

export function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  return request<T>(path, opts, false);
}
