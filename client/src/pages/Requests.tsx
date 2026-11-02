import { useQuery } from '@tanstack/react-query';
import { Pause, Play, Trash2 } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { endpoints, type AccessEntry } from '../api';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  KeyValue,
  Modal,
  PageHeader,
  SearchInput,
  Spinner,
  type Tone,
} from '../components/ui';
import { useStream } from '../hooks/useStream';
import { formatBytes, formatDateTime, formatNumber } from '../utils/format';

const MAX_ROWS = 2000;
const SHOWN_ROWS = 300;
const PANEL_SERVICE = 'vps-panel';

type StatusFilter = 'all' | '2xx' | '3xx' | '4xx' | '5xx';

interface RequestsMessage {
  type: 'requests' | 'end';
  items?: AccessEntry[];
}

function statusTone(status: number): Tone {
  if (status >= 500) return 'critical';
  if (status >= 400) return 'warning';
  if (status >= 300) return 'info';
  return 'good';
}

function statusClass(status: number): StatusFilter {
  return `${Math.floor(status / 100)}xx` as StatusFilter;
}

function formatDuration(seconds: number): string {
  if (seconds >= 1) return `${seconds.toFixed(2)} s`;
  return `${Math.round(seconds * 1000)} ms`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** The domain when nginx logged it, otherwise the app that handled the request. */
function siteName(entry: AccessEntry): string {
  return entry.host || appName(entry);
}

function appName(entry: AccessEntry): string {
  if (!entry.service) return '';
  return entry.namespace ? `${entry.namespace}/${entry.service}` : entry.service;
}

function isPrivate(ip: string): boolean {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|f[cd])/.test(ip);
}

function Count({ label, value, alert }: { label: string; value: number; alert?: { tone: Tone; text: string } }) {
  return (
    <div className="count">
      <span className="tile-label">{label}</span>
      <span className="count-value">
        {formatNumber(value)}
        {alert && value > 0 && <Badge tone={alert.tone}>{alert.text}</Badge>}
      </span>
    </div>
  );
}

function RequestModal({ entry, onClose }: { entry: AccessEntry; onClose: () => void }) {
  return (
    <Modal
      size="md"
      onClose={onClose}
      title={
        <span className="row">
          <Badge tone={statusTone(entry.status)}>{entry.status}</Badge>
          {entry.method || 'Invalid request'}
        </span>
      }
    >
      <KeyValue
        items={[
          ['Time', formatDateTime(entry.ts)],
          ['Path', <span className="mono">{entry.path}</span>],
          ['Domain', entry.host],
          ['App', appName(entry) || 'Answered by nginx'],
          ['Client', <span className="mono">{entry.client}</span>],
          ['Protocol', entry.protocol],
          ['Response size', formatBytes(entry.bytes)],
          ['Duration', formatDuration(entry.duration)],
          ['Sent to', entry.upstream ? <span className="mono">{entry.upstream}</span> : null],
          ['App status', entry.upstreamStatus],
          ['Referrer', entry.referer],
          ['User agent', entry.userAgent],
          ['Request ID', <span className="mono small">{entry.id}</span>],
        ]}
      />
    </Modal>
  );
}

export function RequestsPage() {
  const [entries, setEntries] = useState<AccessEntry[]>([]);
  const [frozen, setFrozen] = useState<AccessEntry[] | null>(null);
  const [search, setSearch] = useState('');
  const [app, setApp] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [showPanel, setShowPanel] = useState(false);
  const [selected, setSelected] = useState<AccessEntry | null>(null);
  const received = useRef(false);

  const caps = useQuery({ queryKey: ['capabilities'], queryFn: endpoints.capabilities, staleTime: Infinity });
  const enabled = caps.data?.kubernetes === true;

  const onMessage = useCallback((message: RequestsMessage) => {
    const items = message.items;
    if (message.type !== 'requests' || !items) return;
    received.current = true;
    // Newest first
    setEntries((prev) => [...items].reverse().concat(prev).slice(0, MAX_ROWS));
  }, []);
  const onOpen = useCallback(() => setEntries([]), []);
  const request = useMemo(() => (enabled ? { channel: 'ingress-requests', tail: 1000 } : null), [enabled]);
  const { status: stream, error } = useStream<RequestsMessage>({ request, onMessage, onOpen });

  const source = frozen ?? entries;
  const base = useMemo(
    () => (showPanel ? source : source.filter((e) => e.service !== PANEL_SERVICE)),
    [source, showPanel],
  );
  const sites = useMemo(() => [...new Set(base.map(siteName).filter(Boolean))].sort(), [base]);

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return base.filter(
      (e) =>
        (!app || siteName(e) === app) &&
        (status === 'all' || statusClass(e.status) === status) &&
        (!needle ||
          e.path.toLowerCase().includes(needle) ||
          e.host.toLowerCase().includes(needle) ||
          e.client.includes(needle) ||
          e.userAgent.toLowerCase().includes(needle) ||
          e.method.toLowerCase() === needle ||
          String(e.status) === needle),
    );
  }, [base, app, status, search]);

  const counts = useMemo(() => {
    const scoped = app ? base.filter((e) => siteName(e) === app) : base;
    return {
      total: scoped.length,
      ok: scoped.filter((e) => e.status < 400).length,
      client: scoped.filter((e) => e.status >= 400 && e.status < 500).length,
      server: scoped.filter((e) => e.status >= 500).length,
    };
  }, [base, app]);

  const oldest = base[base.length - 1];
  const mostlyInternal = base.filter((e) => isPrivate(e.client)).length > base.length / 2;

  if (caps.data && !caps.data.kubernetes) {
    return (
      <>
        <PageHeader title="Requests" />
        <Card>
          <EmptyState
            title="No nginx ingress to read from"
            hint="Incoming requests appear here when the panel runs on a server with the nginx ingress controller."
          />
        </Card>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Requests"
        subtitle="Every request reaching your sites through nginx, newest first"
        actions={
          <>
            {frozen ? (
              <Badge tone="info">Paused</Badge>
            ) : stream === 'open' ? (
              <Badge tone="good">Live</Badge>
            ) : stream === 'error' ? (
              <Badge tone="critical">Error</Badge>
            ) : (
              <Badge tone="info">Connecting</Badge>
            )}
            <Button
              icon={frozen ? <Play size={14} /> : <Pause size={14} />}
              onClick={() => setFrozen(frozen ? null : entries)}
            >
              {frozen ? `Resume${entries.length - frozen.length > 0 ? ` (${entries.length - frozen.length} new)` : ''}` : 'Pause'}
            </Button>
            <Button
              icon={<Trash2 size={14} />}
              onClick={() => {
                setEntries([]);
                setFrozen(null);
              }}
            >
              Clear
            </Button>
          </>
        }
      />

      {error && (
        <div className="notice notice-critical" role="alert">
          {error}
        </div>
      )}

      <div className="grid counts">
        <Count label="Requests" value={counts.total} />
        <Count label="Successful" value={counts.ok} />
        <Count label="Client errors (4xx)" value={counts.client} />
        <Count
          label="Server errors (5xx)"
          value={counts.server}
          alert={{ tone: 'critical', text: 'Your apps are failing requests' }}
        />
      </div>

      <Card flush>
        <div className="toolbar padded">
          <label className="select">
            <span className="muted small">Site</span>
            <select value={app} onChange={(e) => setApp(e.target.value)}>
              <option value="">All</option>
              {sites.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="select">
            <span className="muted small">Status</span>
            <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
              <option value="all">All</option>
              <option value="2xx">2xx success</option>
              <option value="3xx">3xx redirect</option>
              <option value="4xx">4xx client error</option>
              <option value="5xx">5xx server error</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={showPanel} onChange={(e) => setShowPanel(e.target.checked)} />
            Include this panel's own requests
          </label>
          <span className="spacer" />
          <SearchInput value={search} onChange={setSearch} placeholder="Path, domain, IP, status…" />
        </div>

        {!received.current && stream !== 'error' && !entries.length ? (
          <Spinner label="Reading the access log…" />
        ) : !rows.length ? (
          <div className="state muted">{base.length ? 'No requests match.' : 'No requests yet.'}</div>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Status</th>
                    <th>Request</th>
                    <th>Site</th>
                    <th>Client</th>
                    <th className="num">Size</th>
                    <th className="num">Duration</th>
                    <th>User agent</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.slice(0, SHOWN_ROWS).map((e) => (
                    <tr key={e.id} className="clickable" onClick={() => setSelected(e)}>
                      <td className="nowrap num-left">{formatTime(e.ts)}</td>
                      <td>
                        <Badge tone={statusTone(e.status)}>{e.status}</Badge>
                      </td>
                      <td>
                        <div className="request mono small" title={`${e.method} ${e.path}`}>
                          {e.method ? (
                            <>
                              <strong>{e.method}</strong> {e.path}
                            </>
                          ) : (
                            <span className="muted">Invalid request</span>
                          )}
                        </div>
                      </td>
                      <td className="nowrap">
                        {e.host || appName(e) || <span className="muted">nginx</span>}
                        {e.host && appName(e) && <div className="muted small">{appName(e)}</div>}
                      </td>
                      <td className="mono small">{e.client}</td>
                      <td className="num">{formatBytes(e.bytes)}</td>
                      <td className="num">{formatDuration(e.duration)}</td>
                      <td>
                        <div className="clip small muted agent" title={e.userAgent}>
                          {e.userAgent || '–'}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="table-foot muted small">
              Showing {formatNumber(Math.min(rows.length, SHOWN_ROWS))} of {formatNumber(rows.length)} matching
              requests{oldest ? `, going back to ${formatDateTime(oldest.ts)}` : ''}. The newest{' '}
              {formatNumber(MAX_ROWS)} are kept in this view.
              {mostlyInternal &&
                ' Most clients show an internal cluster address because the ingress does not currently receive visitors’ real IPs.'}
            </div>
          </>
        )}
      </Card>
      {selected && <RequestModal entry={selected} onClose={() => setSelected(null)} />}
    </>
  );
}
