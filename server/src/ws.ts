import type { Server } from 'http';
import type { Readable } from 'stream';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { verifyToken } from './auth';
import type { ChildProcessWithoutNullStreams } from 'child_process';
import type { IncomingMessage } from 'http';
import { auditEvent } from './audit';
import { config } from './config';
import { followContainerLogs, openShell } from './services/docker';
import { followIngressLog, parseAccessLine } from './services/ingressLog';
import { followPodLogs, listNamespaces } from './services/kubernetes';
import { getMetricsHistory, onMetrics } from './services/system';
import { followServiceLogs } from './services/systemd';
import { errorMessage } from './utils/http';

/**
 * One socket carries one stream. The first message authenticates and selects it:
 *   { token, channel: 'metrics' }
 *   { token, channel: 'docker-logs',  id: '<container>', tail?: 200 }
 *   { token, channel: 'service-logs', name: '<unit>',    tail?: 200 }
 *   { token, channel: 'pod-logs', namespace, pod, container?, tail?: 200 }
 *   { token, channel: 'ingress-requests', tail?: 500 }
 *   { token, channel: 'docker-shell', id, cols, rows }  then { type: 'input', data } / { type: 'resize', cols, rows }
 */
const startSchema = z.discriminatedUnion('channel', [
  z.object({ token: z.string(), channel: z.literal('metrics') }),
  z.object({
    token: z.string(),
    channel: z.literal('docker-logs'),
    id: z.string(),
    tail: z.number().int().min(0).max(5000).default(200),
  }),
  z.object({
    token: z.string(),
    channel: z.literal('service-logs'),
    name: z.string(),
    tail: z.number().int().min(0).max(5000).default(200),
  }),
  z.object({
    token: z.string(),
    channel: z.literal('pod-logs'),
    namespace: z.string(),
    pod: z.string(),
    container: z.string().optional(),
    tail: z.number().int().min(0).max(5000).default(200),
  }),
  z.object({
    token: z.string(),
    channel: z.literal('docker-shell'),
    id: z.string(),
    cols: z.number().int().min(10).max(500).default(80),
    rows: z.number().int().min(4).max(200).default(24),
  }),
  z.object({
    token: z.string(),
    channel: z.literal('ingress-requests'),
    tail: z.number().int().min(0).max(5000).default(500),
  }),
]);

type Cleanup = () => void;

function send(socket: WebSocket, payload: unknown): void {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

interface LineFormat {
  /** Message type and the key the batch is sent under. */
  type: string;
  key: string;
  /** Converts a raw line; returning null drops it. */
  map: (line: string) => unknown;
}

const RAW_LINES: LineFormat = { type: 'lines', key: 'lines', map: (line) => line };

/** Splits a byte stream into lines and flushes them to the socket in small batches. */
function pipeLines(socket: WebSocket, stream: Readable, format: LineFormat = RAW_LINES): Cleanup {
  let partial = '';
  let pending: unknown[] = [];
  const flush = () => {
    if (!pending.length) return;
    send(socket, { type: format.type, [format.key]: pending });
    pending = [];
  };
  const add = (lines: string[]) => {
    for (const line of lines) {
      const item = format.map(line);
      if (item !== null) pending.push(item);
    }
  };
  const timer = setInterval(flush, 150);

  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    // Apply backpressure by dropping when the browser cannot keep up
    if (socket.bufferedAmount > 4 * 1024 * 1024) return;
    const parts = (partial + chunk).split('\n');
    partial = parts.pop() ?? '';
    add(parts);
    if (pending.length > 500) flush();
  });
  stream.on('end', () => {
    if (partial) add([partial]);
    flush();
    send(socket, { type: 'end' });
  });
  stream.on('error', (err) => send(socket, { type: 'error', error: errorMessage(err) }));

  return () => clearInterval(timer);
}

/** Streams a log-following command (journalctl, kubectl logs) until the socket closes. */
function pipeChild(
  socket: WebSocket,
  child: ChildProcessWithoutNullStreams,
  label: string,
  format?: LineFormat,
): Cleanup {
  const stopPipe = pipeLines(socket, child.stdout, format);
  let stderr = '';
  child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
  child.on('error', (err) => send(socket, { type: 'error', error: errorMessage(err) }));
  child.on('exit', (code) => {
    if (code) send(socket, { type: 'error', error: stderr.trim() || `${label} exited with code ${code}` });
  });
  return () => {
    stopPipe();
    child.kill();
  };
}

const shellInputSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('input'), data: z.string().max(65_536) }),
  z.object({ type: z.literal('resize'), cols: z.number().int().min(10).max(500), rows: z.number().int().min(4).max(200) }),
]);

/** Bridges an interactive container shell: output goes out base64 encoded, keystrokes come in as JSON. */
async function startShell(socket: WebSocket, id: string, cols: number, rows: number): Promise<Cleanup> {
  const session = await openShell(id, cols, rows);
  session.onData((chunk) => {
    if (socket.bufferedAmount < 4 * 1024 * 1024) send(socket, { type: 'output', data: chunk.toString('base64') });
  });
  session.onEnd(() => {
    send(socket, { type: 'end' });
    socket.close(1000, 'Shell exited');
  });
  const onMessage = (raw: Buffer | ArrayBuffer | Buffer[]) => {
    try {
      const msg = shellInputSchema.parse(JSON.parse(raw.toString()));
      if (msg.type === 'input') session.write(Buffer.from(msg.data, 'base64'));
      else session.resize(msg.cols, msg.rows);
    } catch {
      // ignore malformed input rather than kill the session
    }
  };
  socket.on('message', onMessage);
  return () => {
    socket.off('message', onMessage);
    session.close();
  };
}

/** Same rule as Express "trust proxy": use the forwarded address only when configured to. */
function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (config.trustProxy && typeof forwarded === 'string') {
    return forwarded.split(',').pop()?.trim() ?? '';
  }
  return req.socket.remoteAddress ?? '';
}

async function start(
  socket: WebSocket,
  msg: z.infer<typeof startSchema>,
  user: string,
  ip: string,
): Promise<Cleanup> {
  switch (msg.channel) {
    case 'metrics': {
      send(socket, { type: 'history', samples: getMetricsHistory() });
      return onMetrics((sample) => send(socket, { type: 'sample', sample }));
    }
    case 'docker-logs': {
      const { stream, stop } = await followContainerLogs(msg.id, msg.tail);
      const stopPipe = pipeLines(socket, stream);
      return () => {
        stopPipe();
        stop();
      };
    }
    case 'service-logs': {
      return pipeChild(socket, followServiceLogs(msg.name, msg.tail), 'journalctl');
    }
    case 'pod-logs': {
      return pipeChild(socket, followPodLogs(msg.namespace, msg.pod, msg.container, msg.tail), 'kubectl');
    }
    case 'docker-shell': {
      auditEvent(user, ip, 'container.shell', msg.id.slice(0, 12), true);
      return startShell(socket, msg.id, msg.cols, msg.rows);
    }
    case 'ingress-requests': {
      const namespaces = await listNamespaces();
      return pipeChild(socket, followIngressLog(msg.tail), 'kubectl', {
        type: 'requests',
        key: 'items',
        map: (line) => parseAccessLine(line, namespaces),
      });
    }
  }
}

export function attachWebSocket(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 128 * 1024 });

  wss.on('connection', (socket, req) => {
    const ip = clientIp(req);
    let cleanup: Cleanup | null = null;
    let closed = false;
    const authTimeout = setTimeout(() => socket.close(4401, 'Authentication timeout'), 5000);

    socket.once('message', (raw) => {
      clearTimeout(authTimeout);
      void (async () => {
        try {
          const msg = startSchema.parse(JSON.parse(raw.toString()));
          const user = verifyToken(msg.token);
          const stop = await start(socket, msg, user.username, ip);
          if (closed) stop();
          else cleanup = stop;
        } catch (err) {
          send(socket, { type: 'error', error: errorMessage(err) });
          socket.close(4400, 'Bad request');
        }
      })();
    });

    socket.on('close', () => {
      closed = true;
      clearTimeout(authTimeout);
      cleanup?.();
    });
    socket.on('error', () => socket.terminate());
  });

  return wss;
}
