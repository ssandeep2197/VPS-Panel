import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef, useState } from 'react';
import { getToken } from '../api';
import { Badge } from './ui';

type Status = 'connecting' | 'open' | 'closed' | 'error';

const encoder = new TextEncoder();

function toBase64(text: string): string {
  return btoa(String.fromCharCode(...encoder.encode(text)));
}

function fromBase64(data: string): Uint8Array {
  return Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
}

/** Interactive shell over the panel's WebSocket. `start` selects the target, e.g. { channel: 'docker-shell', id }. */
export function Terminal({ start }: { start: Record<string, unknown> }) {
  const host = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<Status>('connecting');
  const [message, setMessage] = useState('');
  const key = JSON.stringify(start);

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const dark = document.documentElement.dataset.theme !== 'light';
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      scrollback: 5000,
      theme: dark
        ? { background: '#0d0d0d', foreground: '#e6e6e6', cursor: '#e6e6e6' }
        : { background: '#f0efec', foreground: '#0b0b0b', cursor: '#0b0b0b' },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();

    const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
    let ended = false;

    socket.onopen = () => {
      socket.send(JSON.stringify({ ...JSON.parse(key), token: getToken(), cols: term.cols, rows: term.rows }));
      setStatus('open');
      term.focus();
    };
    let focused = false;
    socket.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as { type: string; data?: string; error?: string };
      if (msg.type === 'output' && msg.data) {
        term.write(fromBase64(msg.data));
        // Take the keyboard once the prompt is visible; the dialog focuses itself on open
        if (!focused) {
          focused = true;
          term.focus();
        }
      }
      else if (msg.type === 'end') {
        ended = true;
        term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n');
      } else if (msg.type === 'error') {
        ended = true;
        setMessage(msg.error ?? 'Error');
        setStatus('error');
      }
    };
    socket.onclose = () => {
      setStatus((s) => (s === 'error' ? s : 'closed'));
      if (!ended) term.write('\r\n\x1b[2m[disconnected]\x1b[0m\r\n');
    };

    const input = term.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'input', data: toBase64(data) }));
    });
    const observer = new ResizeObserver(() => {
      fit.fit();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    });
    observer.observe(el);

    return () => {
      observer.disconnect();
      input.dispose();
      socket.close();
      term.dispose();
    };
  }, [key]);

  return (
    <div className="terminal">
      <div className="toolbar">
        <span className="muted small">
          Shell inside the container. Type <code>exit</code> or use the × button to end the session; Escape is passed
          to the shell.
        </span>
        <span className="spacer" />
        {status === 'open' && <Badge tone="good">Connected</Badge>}
        {status === 'connecting' && <Badge tone="info">Connecting</Badge>}
        {status === 'closed' && <Badge tone="neutral">Session ended</Badge>}
        {status === 'error' && <Badge tone="critical">Error</Badge>}
      </div>
      {message && (
        <div className="notice notice-critical" role="alert">
          {message}
        </div>
      )}
      <div className="terminal-box" ref={host} />
    </div>
  );
}
