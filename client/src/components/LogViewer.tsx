import { ArrowDownToLine, Download, Eraser } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStream } from '../hooks/useStream';
import { Badge, Button, SearchInput } from './ui';

const MAX_LINES = 5000;

interface LogMessage {
  type: 'lines' | 'end';
  lines?: string[];
}

/** Live tail of a container or systemd unit over WebSocket. */
export function LogViewer({ request, filename }: { request: Record<string, unknown>; filename: string }) {
  const [lines, setLines] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLPreElement>(null);

  const onMessage = useCallback((message: LogMessage) => {
    const incoming = message.lines;
    if (message.type !== 'lines' || !incoming) return;
    setLines((prev) => {
      const next = prev.concat(incoming);
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  }, []);
  const onOpen = useCallback(() => setLines([]), []);

  const { status, error } = useStream<LogMessage>({ request, onMessage, onOpen });

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return needle ? lines.filter((l) => l.toLowerCase().includes(needle)) : lines;
  }, [lines, filter]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [visible, follow]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };

  const download = () => {
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="logs">
      <div className="toolbar">
        <SearchInput value={filter} onChange={setFilter} placeholder="Filter lines…" />
        <span className="spacer" />
        {status === 'open' && <Badge tone="good">Live</Badge>}
        {status === 'connecting' && <Badge tone="info">Connecting</Badge>}
        {status === 'closed' && <Badge tone="neutral">Stream ended</Badge>}
        {status === 'error' && <Badge tone="critical">Error</Badge>}
        <Button
          size="sm"
          icon={<ArrowDownToLine size={14} />}
          onClick={() => setFollow(true)}
          disabled={follow}
          title="Jump to newest and follow"
        >
          Follow
        </Button>
        <Button size="sm" icon={<Eraser size={14} />} onClick={() => setLines([])}>
          Clear
        </Button>
        <Button size="sm" icon={<Download size={14} />} onClick={download} disabled={!lines.length}>
          Save
        </Button>
      </div>
      {error && (
        <div className="notice notice-critical" role="alert">
          {error}
        </div>
      )}
      <pre className="log-box" ref={box} onScroll={onScroll} tabIndex={0}>
        {visible.length ? visible.join('\n') : status === 'open' ? 'No log lines yet.' : ''}
      </pre>
      <div className="muted small">
        {visible.length.toLocaleString()} {filter ? `of ${lines.length.toLocaleString()} ` : ''}lines
        {lines.length >= MAX_LINES ? ` (showing the newest ${MAX_LINES.toLocaleString()})` : ''}
      </div>
    </div>
  );
}
