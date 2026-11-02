import { useEffect, useRef, useState } from 'react';
import { getToken } from '../api';

export type StreamStatus = 'connecting' | 'open' | 'closed' | 'error';

interface StreamOptions<T> {
  /** Stream selector sent as the first message, e.g. { channel: 'metrics' }. Pass null to stay disconnected. */
  request: Record<string, unknown> | null;
  onMessage: (message: T) => void;
  /** Called on every (re)connect so the consumer can reset buffered state. */
  onOpen?: () => void;
}

/** Opens an authenticated WebSocket stream and reconnects with backoff if it drops. */
export function useStream<T>({ request, onMessage, onOpen }: StreamOptions<T>) {
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [error, setError] = useState<string | null>(null);
  const handlers = useRef({ onMessage, onOpen });
  handlers.current = { onMessage, onOpen };
  const key = request ? JSON.stringify(request) : null;

  useEffect(() => {
    if (!key) return;
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let disposed = false;
    let ended = false;

    const connect = () => {
      setStatus('connecting');
      const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${scheme}://${window.location.host}/ws`);

      socket.onopen = () => {
        socket?.send(JSON.stringify({ ...JSON.parse(key), token: getToken() }));
        handlers.current.onOpen?.();
        setStatus('open');
        setError(null);
      };
      socket.onmessage = (event) => {
        attempts = 0;
        const message = JSON.parse(String(event.data)) as { type?: string; error?: string };
        if (message.type === 'error') {
          ended = true;
          setError(message.error ?? 'Stream error');
          setStatus('error');
          return;
        }
        if (message.type === 'end') ended = true;
        handlers.current.onMessage(message as T);
      };
      socket.onclose = () => {
        if (disposed) return;
        if (ended) {
          setStatus((s) => (s === 'error' ? s : 'closed'));
          return;
        }
        setStatus('connecting');
        attempts += 1;
        retry = setTimeout(connect, Math.min(15_000, 1000 * 2 ** Math.min(attempts, 4)));
      };
    };

    connect();
    return () => {
      disposed = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [key]);

  return { status, error };
}
