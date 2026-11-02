import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText, Pause, Play, RotateCw, Square, SquareTerminal, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { endpoints, type Container, type ContainerAction } from '../api';
import { LogViewer } from '../components/LogViewer';
import { Terminal } from '../components/Terminal';
import {
  Badge,
  Button,
  Card,
  KeyValue,
  Modal,
  PageHeader,
  QueryView,
  SearchInput,
  Tabs,
  Tag,
  useFeedback,
  type Tone,
} from '../components/ui';
import { formatAgo, formatBytes, formatDateTime, formatPercent } from '../utils/format';

type Tab = 'containers' | 'images' | 'volumes' | 'networks';

function stateTone(state: string): Tone {
  if (state === 'running') return 'good';
  if (state === 'paused') return 'info';
  if (state === 'restarting' || state === 'created') return 'warning';
  if (state === 'dead') return 'critical';
  return 'neutral';
}

const PAST: Record<ContainerAction, string> = {
  start: 'started',
  stop: 'stopped',
  restart: 'restarted',
  pause: 'paused',
  unpause: 'resumed',
  kill: 'killed',
};

function useInvalidateDocker() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['docker'] });
}

type ContainerTab = 'logs' | 'details' | 'terminal';

function ContainerModal({
  container,
  onClose,
  initialTab = 'logs',
}: {
  container: Container;
  onClose: () => void;
  initialTab?: ContainerTab;
}) {
  const [tab, setTab] = useState<ContainerTab>(initialTab);
  const detail = useQuery({
    queryKey: ['docker', 'container', container.id],
    queryFn: () => endpoints.container(container.id),
  });

  return (
    <Modal
      size="lg"
      onClose={onClose}
      title={
        <span className="row">
          {container.name}
          <Badge tone={stateTone(detail.data?.state ?? container.state)}>{detail.data?.state ?? container.state}</Badge>
        </span>
      }
    >
      <div className="toolbar">
        <Tabs
          tabs={[
            { id: 'logs', label: 'Logs' },
            { id: 'details', label: 'Details' },
            ...(container.state === 'running' ? [{ id: 'terminal' as const, label: 'Terminal' }] : []),
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
      {tab === 'logs' ? (
        <LogViewer
          request={{ channel: 'docker-logs', id: container.id, tail: 300 }}
          filename={`${container.name}.log`}
        />
      ) : tab === 'terminal' ? (
        <Terminal start={{ channel: 'docker-shell', id: container.id }} />
      ) : (
        <QueryView query={detail}>
          {(d) => (
            <KeyValue
              items={[
                ['Image', <span className="mono">{d.image}</span>],
                ['Container ID', <span className="mono">{d.id.slice(0, 12)}</span>],
                ['Command', <span className="mono">{d.command}</span>],
                ['Created', formatDateTime(d.created)],
                ['Started', formatDateTime(d.startedAt)],
                ['Health', d.health],
                ['Exit code', d.state === 'running' ? null : d.exitCode],
                ['Restart policy', d.restartPolicy],
                ['Restart count', d.restartCount],
                ['Ports', d.ports.length ? d.ports.join(', ') : null],
                ['Networks', d.networks.map((n) => `${n.name}${n.ip ? ` (${n.ip})` : ''}`).join(', ')],
                [
                  'Mounts',
                  d.mounts.length ? (
                    <div className="stack mono small">
                      {d.mounts.map((m) => (
                        <span key={m.destination}>
                          {m.source} → {m.destination} {m.rw ? '' : '(read-only)'}
                        </span>
                      ))}
                    </div>
                  ) : null,
                ],
                [
                  'Environment',
                  d.envNames.length ? (
                    <div className="tags" title="Values are hidden because they often contain secrets">
                      {d.envNames.map((name) => (
                        <Tag key={name}>{name}</Tag>
                      ))}
                    </div>
                  ) : null,
                ],
              ]}
            />
          )}
        </QueryView>
      )}
    </Modal>
  );
}

function Containers() {
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<{ container: Container; tab: ContainerTab } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, attempt } = useFeedback();
  const invalidate = useInvalidateDocker();

  const containers = useQuery({ queryKey: ['docker', 'containers'], queryFn: endpoints.containers, refetchInterval: 5000 });
  const stats = useQuery({
    queryKey: ['docker', 'stats'],
    queryFn: endpoints.containerStats,
    refetchInterval: 6000,
    enabled: Boolean(containers.data?.some((c) => c.state === 'running')),
  });

  const act = async (c: Container, action: ContainerAction) => {
    if (action === 'stop' || action === 'kill' || action === 'restart') {
      const ok = await confirm({
        title: `${action[0].toUpperCase()}${action.slice(1)} ${c.name}?`,
        message:
          action === 'restart'
            ? 'The container will be briefly unavailable while it restarts.'
            : 'The container will stop running until it is started again.',
        confirmLabel: action[0].toUpperCase() + action.slice(1),
        danger: action !== 'restart',
      });
      if (!ok) return;
    }
    setBusy(`${c.id}:${action}`);
    await attempt(`${c.name} ${PAST[action]}`, () => endpoints.containerAction(c.id, action, c.name));
    setBusy(null);
    await invalidate();
  };

  const remove = async (c: Container) => {
    const running = c.state === 'running' || c.state === 'paused';
    const ok = await confirm({
      title: `Remove ${c.name}?`,
      message: running
        ? 'This container is running. It will be force-stopped and deleted. Data outside of volumes is lost.'
        : 'The container will be deleted. Data outside of volumes is lost.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    setBusy(`${c.id}:remove`);
    await attempt(`${c.name} removed`, () => endpoints.removeContainer(c.id, running));
    setBusy(null);
    await invalidate();
  };

  return (
    <>
      <div className="toolbar padded">
        <SearchInput value={search} onChange={setSearch} placeholder="Search containers…" />
      </div>
      <QueryView
        query={containers}
        empty={{ when: (d) => !d.length, title: 'No containers', hint: 'Containers you create on this host appear here.' }}
      >
        {(data) => {
          const needle = search.trim().toLowerCase();
          const rows = data.filter(
            (c) => !needle || c.name.toLowerCase().includes(needle) || c.image.toLowerCase().includes(needle),
          );
          if (!rows.length) return <div className="state muted">No containers match.</div>;
          return (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Container</th>
                    <th>State</th>
                    <th className="num">CPU</th>
                    <th className="num">Memory</th>
                    <th>Ports</th>
                    <th className="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => {
                    const s = stats.data?.[c.id];
                    const running = c.state === 'running';
                    const paused = c.state === 'paused';
                    return (
                      <tr key={c.id}>
                        <td>
                          <button type="button" className="link" onClick={() => setSelected({ container: c, tab: 'logs' })}>
                            {c.name}
                          </button>
                          {c.project && <Tag>{c.project}</Tag>}
                          <div className="muted small mono">{c.image}</div>
                        </td>
                        <td>
                          <Badge tone={stateTone(c.state)}>{c.state}</Badge>
                          <div className="muted small">{c.status}</div>
                        </td>
                        <td className="num">{s ? formatPercent(s.cpu) : '–'}</td>
                        <td className="num">{s ? formatBytes(s.memUsed) : '–'}</td>
                        <td className="small mono">{c.ports.join(', ') || '–'}</td>
                        <td className="actions">
                          {!running && !paused && (
                            <Button size="sm" icon={<Play size={14} />} title="Start" aria-label={`Start ${c.name}`} loading={busy === `${c.id}:start`} onClick={() => act(c, 'start')} />
                          )}
                          {paused && (
                            <Button size="sm" icon={<Play size={14} />} title="Resume" aria-label={`Resume ${c.name}`} loading={busy === `${c.id}:unpause`} onClick={() => act(c, 'unpause')} />
                          )}
                          {running && (
                            <>
                              <Button size="sm" icon={<RotateCw size={14} />} title="Restart" aria-label={`Restart ${c.name}`} loading={busy === `${c.id}:restart`} onClick={() => act(c, 'restart')} />
                              <Button size="sm" icon={<Pause size={14} />} title="Pause" aria-label={`Pause ${c.name}`} loading={busy === `${c.id}:pause`} onClick={() => act(c, 'pause')} />
                              <Button size="sm" icon={<Square size={14} />} title="Stop" aria-label={`Stop ${c.name}`} loading={busy === `${c.id}:stop`} onClick={() => act(c, 'stop')} />
                            </>
                          )}
                          {running && (
                            <Button size="sm" icon={<SquareTerminal size={14} />} title="Open terminal" aria-label={`Terminal in ${c.name}`} onClick={() => setSelected({ container: c, tab: 'terminal' })} />
                          )}
                          <Button size="sm" icon={<FileText size={14} />} title="Logs and details" aria-label={`Logs for ${c.name}`} onClick={() => setSelected({ container: c, tab: 'logs' })} />
                          <Button size="sm" variant="danger" icon={<Trash2 size={14} />} title="Remove" aria-label={`Remove ${c.name}`} loading={busy === `${c.id}:remove`} onClick={() => remove(c)} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        }}
      </QueryView>
      {selected && (
        <ContainerModal container={selected.container} initialTab={selected.tab} onClose={() => setSelected(null)} />
      )}
    </>
  );
}

function Images() {
  const [pulling, setPulling] = useState(false);
  const [image, setImage] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, attempt } = useFeedback();
  const invalidate = useInvalidateDocker();
  const images = useQuery({ queryKey: ['docker', 'images'], queryFn: endpoints.images });

  const pull = async (e: FormEvent) => {
    e.preventDefault();
    const ref = image.trim();
    if (!ref) return;
    setPulling(true);
    const ok = await attempt(`Pulled ${ref}`, () => endpoints.pullImage(ref));
    setPulling(false);
    if (ok) setImage('');
    await invalidate();
  };

  const remove = async (id: string, label: string, inUse: boolean) => {
    const ok = await confirm({
      title: `Remove image ${label}?`,
      message: inUse
        ? 'A container uses this image. Removal will fail unless that container is removed first.'
        : 'The image will be deleted from this host. It can be pulled again later.',
      confirmLabel: 'Remove',
      danger: true,
    });
    if (!ok) return;
    setBusy(id);
    await attempt(`Removed ${label}`, () => endpoints.removeImage(id, false));
    setBusy(null);
    await invalidate();
  };

  return (
    <>
      <form className="toolbar padded" onSubmit={pull}>
        <input
          className="input grow"
          value={image}
          onChange={(e) => setImage(e.target.value)}
          placeholder="Image to pull, e.g. nginx:1.27"
          aria-label="Image to pull"
          disabled={pulling}
        />
        <Button type="submit" variant="primary" icon={<Download size={14} />} loading={pulling} disabled={!image.trim()}>
          {pulling ? 'Pulling…' : 'Pull image'}
        </Button>
      </form>
      <QueryView query={images} empty={{ when: (d) => !d.length, title: 'No images' }}>
        {(data) => (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Image</th>
                  <th>ID</th>
                  <th>Status</th>
                  <th className="num">Size</th>
                  <th>Created</th>
                  <th className="actions">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.map((img) => {
                  const label = img.tags[0] ?? img.id.replace('sha256:', '').slice(0, 12);
                  return (
                    <tr key={img.id}>
                      <td className="mono">
                        {img.tags.length ? (
                          img.tags.map((t) => <div key={t}>{t}</div>)
                        ) : (
                          <span className="muted">untagged</span>
                        )}
                      </td>
                      <td className="mono small">{img.id.replace('sha256:', '').slice(0, 12)}</td>
                      <td>{img.inUse ? <Badge tone="good">In use</Badge> : <Badge tone="neutral">Unused</Badge>}</td>
                      <td className="num">{formatBytes(img.size)}</td>
                      <td>{formatAgo(img.created)}</td>
                      <td className="actions">
                        <Button size="sm" variant="danger" icon={<Trash2 size={14} />} title="Remove" aria-label={`Remove ${label}`} loading={busy === img.id} onClick={() => remove(img.id, label, img.inUse)} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </QueryView>
    </>
  );
}

function Volumes() {
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, attempt } = useFeedback();
  const invalidate = useInvalidateDocker();
  const volumes = useQuery({ queryKey: ['docker', 'volumes'], queryFn: endpoints.volumes });

  const remove = async (name: string) => {
    const ok = await confirm({
      title: `Delete volume ${name}?`,
      message: 'All data stored in this volume is permanently deleted. This cannot be undone.',
      confirmLabel: 'Delete volume',
      danger: true,
    });
    if (!ok) return;
    setBusy(name);
    await attempt(`Volume ${name} deleted`, () => endpoints.removeVolume(name));
    setBusy(null);
    await invalidate();
  };

  return (
    <QueryView query={volumes} empty={{ when: (d) => !d.length, title: 'No volumes' }}>
      {(data) => (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Volume</th>
                <th>Driver</th>
                <th>Used by</th>
                <th>Created</th>
                <th className="actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.map((v) => (
                <tr key={v.name}>
                  <td>
                    <div className="mono clip" title={v.name}>
                      {v.name}
                    </div>
                    <div className="muted small mono clip" title={v.mountpoint}>
                      {v.mountpoint}
                    </div>
                  </td>
                  <td>{v.driver}</td>
                  <td>
                    {v.usedBy.length ? (
                      <div className="tags">
                        {v.usedBy.map((n) => (
                          <Tag key={n}>{n}</Tag>
                        ))}
                      </div>
                    ) : (
                      <span className="muted">Unused</span>
                    )}
                  </td>
                  <td>{v.created ? formatAgo(v.created) : '–'}</td>
                  <td className="actions">
                    <Button
                      size="sm"
                      variant="danger"
                      icon={<Trash2 size={14} />}
                      title={v.usedBy.length ? 'In use by a container' : 'Delete'}
                      aria-label={`Delete volume ${v.name}`}
                      disabled={v.usedBy.length > 0}
                      loading={busy === v.name}
                      onClick={() => remove(v.name)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </QueryView>
  );
}

function Networks() {
  const networks = useQuery({ queryKey: ['docker', 'networks'], queryFn: endpoints.networks });
  return (
    <QueryView query={networks} empty={{ when: (d) => !d.length, title: 'No networks' }}>
      {(data) => (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Network</th>
                <th>Driver</th>
                <th>Scope</th>
                <th>Subnet</th>
              </tr>
            </thead>
            <tbody>
              {data.map((n) => (
                <tr key={n.id}>
                  <td>
                    <span className="mono">{n.name}</span> {n.internal && <Tag>internal</Tag>}
                    <div className="muted small mono">{n.id.slice(0, 12)}</div>
                  </td>
                  <td>{n.driver}</td>
                  <td>{n.scope}</td>
                  <td className="mono">{n.subnet ?? '–'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </QueryView>
  );
}

export function DockerPage() {
  const [tab, setTab] = useState<Tab>('containers');
  const info = useQuery({ queryKey: ['docker', 'info'], queryFn: endpoints.dockerInfo, refetchInterval: 15_000 });

  return (
    <>
      <PageHeader
        title="Docker"
        subtitle={
          info.data
            ? `Docker ${info.data.version} · ${info.data.os} · ${info.data.running} of ${info.data.containers} containers running`
            : info.error
              ? 'Docker daemon unavailable'
              : 'Connecting to the Docker daemon…'
        }
      />
      <Card flush>
        <div className="toolbar padded">
          <Tabs
            tabs={[
              { id: 'containers', label: 'Containers', count: info.data?.containers },
              { id: 'images', label: 'Images', count: info.data?.images },
              { id: 'volumes', label: 'Volumes' },
              { id: 'networks', label: 'Networks' },
            ]}
            value={tab}
            onChange={setTab}
          />
        </div>
        {tab === 'containers' && <Containers />}
        {tab === 'images' && <Images />}
        {tab === 'volumes' && <Volumes />}
        {tab === 'networks' && <Networks />}
      </Card>
    </>
  );
}
