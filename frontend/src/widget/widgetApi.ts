import { ApiError } from "../lib/api";

let widgetToken: string | null = null;

export function setWidgetToken(token: string | null) {
  widgetToken = token;
}

export function getWidgetToken(): string | null {
  return widgetToken;
}

export async function widgetApi<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (widgetToken) headers.Authorization = `Bearer ${widgetToken}`;

  const res = await fetch(path, {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const envelope = await res.json();
  if (envelope.code === "OK") return envelope.data as T;
  throw new ApiError(envelope.code, envelope.msg);
}
