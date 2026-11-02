import { useQuery, useQueryClient } from '@tanstack/react-query';
import { XOctagon } from 'lucide-react';
import { useMemo, useState } from 'react';
import { endpoints, type ProcessRow } from '../api';
import { Button, Card, Modal, PageHeader, QueryView, SearchInput, Tabs, useFeedback } from '../components/ui';
import { formatBytes, formatNumber, formatPercent } from '../utils/format';

type Tab = 'processes' | 'ports';
type Sort = 'cpu' | 'mem';

const SIGNALS = [
  { id: 'SIGTERM', label: 'Terminate (SIGTERM)', hint: 'Asks the process to shut down cleanly.' },
  { id: 'SIGKILL', label: 'Kill (SIGKILL)', hint: 'Ends the process immediately. Unsaved work is lost.' },
  { id: 'SIGHUP', label: 'Hang up (SIGHUP)', hint: 'Many daemons reload their configuration.' },
  { id: 'SIGINT', label: 'Interrupt (SIGINT)', hint: 'Same as pressing Ctrl+C.' },
];

function KillModal({ process, onClose }: { process: ProcessRow; onClose: () => void }) {
  const [signal, setSignal] = useState('SIGTERM');
  const [busy, setBusy] = useState(false);
  const { attempt } = useFeedback();
  const queryClient = useQueryClient();

  const send = async () => {
    setBusy(true);
    const ok = await attempt(`Sent ${signal} to ${process.name} (${process.pid})`, () =>
      endpoints.killProcess(process.pid, signal),
    );
    setBusy(false);
    if (ok) {
      await queryClient.invalidateQueries({ queryKey: ['processes'] });
      onClose();
    }
  };

  return (
    <Modal
      title={`Signal ${process.name} (PID ${process.pid})`}
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={busy} onClick={send}>
            Send {signal}
          </Button>
        </>
      }
    >
      <div className="stack">
        <div className="mono small clip-2">{process.command || process.name}</div>
        {SIGNALS.map((s) => (
          <label key={s.id} className="radio">
            <input type="radio" name="signal" checked={signal === s.id} onChange={() => setSignal(s.id)} />
            <span>
              <strong>{s.label}</strong>
              <span className="muted small">{s.hint}</span>
            </span>
          </label>
        ))}
      </div>
    </Modal>
  );
}

export function ProcessesPage() {
  const [tab, setTab] = useState<Tab>('processes');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<Sort>('cpu');
  const [target, setTarget] = useState<ProcessRow | null>(null);

  const processes = useQuery({
    queryKey: ['processes'],
    queryFn: endpoints.processes,
    refetchInterval: 5000,
    enabled: tab === 'processes',
  });
  const ports = useQuery({
    queryKey: ['ports'],
    queryFn: endpoints.ports,
    refetchInterval: 15_000,
    enabled: tab === 'ports',
  });

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = (processes.data?.list ?? []).filter(
      (p) =>
        !needle ||
        p.name.toLowerCase().includes(needle) ||
        p.command.toLowerCase().includes(needle) ||
        p.user.toLowerCase().includes(needle) ||
        String(p.pid) === needle,
    );
    return [...list].sort((a, b) => (sort === 'cpu' ? b.cpu - a.cpu : b.mem - a.mem)).slice(0, 100);
  }, [processes.data, search, sort]);

  return (
    <>
      <PageHeader
        title="Processes"
        subtitle={
          processes.data
            ? `${formatNumber(processes.data.total)} processes · ${processes.data.running} running`
            : 'Processes and listening ports'
        }
      />
      <Card flush>
        <div className="toolbar padded">
          <Tabs
            tabs={[
              { id: 'processes', label: 'Processes' },
              { id: 'ports', label: 'Listening ports', count: ports.data?.length },
            ]}
            value={tab}
            onChange={setTab}
          />
          <span className="spacer" />
          {tab === 'processes' && (
            <>
              <label className="select">
                <span className="muted small">Sort by</span>
                <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}>
                  <option value="cpu">CPU</option>
                  <option value="mem">Memory</option>
                </select>
              </label>
              <SearchInput value={search} onChange={setSearch} placeholder="Name, user or PID…" />
            </>
          )}
        </div>

        {tab === 'processes' && (
          <QueryView query={processes}>
            {() =>
              rows.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th className="num">PID</th>
                        <th>Process</th>
                        <th>User</th>
                        <th className="num">CPU</th>
                        <th className="num">Memory</th>
                        <th className="num">RSS</th>
                        <th className="actions">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((p) => (
                        <tr key={p.pid}>
                          <td className="num">{p.pid}</td>
                          <td>
                            <div>{p.name}</div>
                            <div className="muted small mono clip" title={p.command}>
                              {p.command}
                            </div>
                          </td>
                          <td>{p.user}</td>
                          <td className="num">{formatPercent(p.cpu)}</td>
                          <td className="num">{formatPercent(p.mem)}</td>
                          <td className="num">{formatBytes(p.memRss)}</td>
                          <td className="actions">
                            <Button
                              size="sm"
                              variant="danger"
                              icon={<XOctagon size={14} />}
                              title="Send signal"
                              aria-label={`Send signal to ${p.name} ${p.pid}`}
                              disabled={p.pid <= 1}
                              onClick={() => setTarget(p)}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="state muted">No processes match.</div>
              )
            }
          </QueryView>
        )}

        {tab === 'ports' && (
          <QueryView query={ports} empty={{ when: (d) => !d.length, title: 'No listening ports found' }}>
            {(data) => (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th className="num">Port</th>
                      <th>Protocol</th>
                      <th>Address</th>
                      <th>Process</th>
                      <th className="num">PID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((p) => (
                      <tr key={`${p.protocol}-${p.address}-${p.port}`}>
                        <td className="num">{p.port}</td>
                        <td>{p.protocol.toUpperCase()}</td>
                        <td className="mono">{p.address}</td>
                        <td>{p.process || <span className="muted">–</span>}</td>
                        <td className="num">{p.pid ?? '–'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </QueryView>
        )}
      </Card>
      {target && <KillModal process={target} onClose={() => setTarget(null)} />}
    </>
  );
}
