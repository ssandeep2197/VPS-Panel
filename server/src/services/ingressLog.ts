import { config } from '../config';
import { spawnStream } from '../utils/exec';

export interface AccessEntry {
  id: string;
  ts: number;
  client: string;
  /** Requested hostname. Empty for entries logged before the hostname was added to the format. */
  host: string;
  method: string;
  path: string;
  protocol: string;
  status: number;
  bytes: number;
  /** Seconds nginx spent on the request, including the app's response time. */
  duration: number;
  referer: string;
  userAgent: string;
  /** Kubernetes service that handled the request; empty when nginx answered by itself. */
  namespace: string;
  service: string;
  upstream: string;
  upstreamStatus: number | null;
}

// ingress-nginx default "log-format-upstream", optionally followed by $host.
// Everything after the two bracketed upstream names is split into fields below.
const LINE_RE =
  /^(\S+) - (\S+) \[([^\]]+)\] "([^"]*)" (\d{3}) (\d+) "([^"]*)" "([^"]*)" (\d+) ([\d.]+) \[([^\]]*)\] \[([^\]]*)\] (.+)$/;

const MONTHS: Record<string, string> = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

/** "29/Sep/2026:20:29:44 +0000" -> epoch milliseconds */
function parseTime(value: string): number {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/.exec(value);
  if (!m) return Date.now();
  return Date.parse(`${m[3]}-${MONTHS[m[2]] ?? '01'}-${m[1]}T${m[4]}${m[5]}:${m[6]}`);
}

/**
 * nginx names an upstream "<namespace>-<service>-<port>". Namespaces can contain
 * hyphens too, so the known namespace list decides where the split goes.
 */
function splitUpstream(name: string, namespaces: string[]): { namespace: string; service: string } {
  if (!name) return { namespace: '', service: '' };
  const withoutPort = name.replace(/-[^-]+$/, '');
  const namespace = namespaces
    .filter((ns) => withoutPort.startsWith(`${ns}-`))
    .sort((a, b) => b.length - a.length)[0];
  if (!namespace) return { namespace: '', service: withoutPort };
  return { namespace, service: withoutPort.slice(namespace.length + 1) };
}

/** Returns null for lines that are not access log entries (controller messages). */
export function parseAccessLine(line: string, namespaces: string[]): AccessEntry | null {
  const m = LINE_RE.exec(line);
  if (!m) return null;
  const [method = '', path = '', protocol = ''] = m[4].split(' ');
  // "addr length time status request-id [host]". The first four become
  // comma separated lists ("a, b") when nginx retries on another pod.
  const tail = m[13].replace(/, /g, ',').split(' ');
  if (tail.length !== 5 && tail.length !== 6) return null;
  const [upstream, , , statuses, id, host = ''] = tail;
  const upstreamStatus = Number(statuses.split(',').pop());
  return {
    id,
    ts: parseTime(m[3]),
    client: m[1],
    host,
    method,
    path,
    protocol,
    status: Number(m[5]),
    bytes: Number(m[6]),
    duration: Number(m[10]),
    referer: m[7] === '-' ? '' : m[7],
    userAgent: m[8] === '-' ? '' : m[8],
    ...splitUpstream(m[11], namespaces),
    upstream: upstream === '-' ? '' : upstream,
    upstreamStatus: Number.isFinite(upstreamStatus) ? upstreamStatus : null,
  };
}

export function followIngressLog(tail: number) {
  return spawnStream(config.kubectl, [
    'logs',
    config.ingress.workload,
    '-n',
    config.ingress.namespace,
    '-f',
    `--tail=${tail}`,
  ]);
}
