import { useCallback, useEffect, useRef, useState } from "react";
import type { WsEvent } from "./types";

type Handlers = { onMessage: (event: WsEvent) => void; onOpen?: () => void };

/** Reconnecting WebSocket with exponential backoff (1s -> 30s). Caller does afterId catch-up in onOpen. */
export function useReconnectingSocket(url: string | null, handlers: Handlers) {
  const wsRef = useRef<WebSocket | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!url) return;
    let cancelled = false;
    let backoffMs = 1000;
    let timer: ReturnType<typeof setTimeout>;

    function connect() {
      if (cancelled || !url) return;
      const ws = new WebSocket(url);
      wsRef.current = ws;
      ws.onopen = () => {
        backoffMs = 1000;
        setConnected(true);
        handlersRef.current.onOpen?.();
      };
      ws.onmessage = (ev) => {
        try {
          handlersRef.current.onMessage(JSON.parse(ev.data));
        } catch {
          // ignore malformed frames
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (cancelled) return;
        timer = setTimeout(connect, backoffMs);
        backoffMs = Math.min(backoffMs * 2, 30_000);
      };
      ws.onerror = () => ws.close();
    }

    connect();
    return () => {
      cancelled = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, [url]);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(data));
  }, []);

  return { send, connected };
}

export function wsUrl(path: string): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}${path}`;
}
