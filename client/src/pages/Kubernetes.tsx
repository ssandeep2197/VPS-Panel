import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, FileText, Lock, RotateCw, Scaling, Trash2 } from 'lucide-react';
import { useMemo, useState, type FormEvent } from 'react';
import { endpoints, type K8sPod, type K8sWorkload } from '../api';
import { LogViewer } from '../components/LogViewer';
import {
  Badge,
  Button,
  Card,
  EmptyState,
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
import { formatAgo, formatBytes, formatDateTime } from '../utils/format';

type Tab = 'workloads' | 'pods' | 'ingresses' | 'events';

const KIND_LABEL: Record<K8sWorkload['kind'], string> = {
  deployment: 'Deployment',
  statefulset: 'StatefulSet',
  daemonset: 'DaemonSet',
};

function podTone(pod: K8sPod): Tone {
  if (pod.status === 'Running') return 'good';
  if (pod.status === 'Completed') return 'neutral';
  if (['Pending', 'ContainerCreating', 'PodInitializing', 'Terminating', 'NotReady'].includes(pod.status)) {
    return 'warning';
  }
  return 'critical';
}

function workloadTone(w: K8sWorkload): Tone {
  if (w.desired === 0) return 'neutral';
  if (w.ready >= w.desired) return 'good';
  return w.ready === 0 ? 'critical' : 'warning';
}

function formatCpu(milli: number | null): string {
  if (milli === null) return '–';
  return milli >= 1000 ? `${(milli / 1000).toFixed(2)} cores` : `${Math.round(milli)}m`;
}

interface Filter {
  namespace: string;
  search: string;
}

function visible(filter: Filter, namespace: string, ...fields: string[]): boolean {
  if (filter.namespace && namespace !== filter.namespace) return false;
  const needle = filter.search.trim().toLowerCase();
  return !needle || fields.some((f) => f.toLowerCase().includes(needle));
}

function useInvalidate() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ['k8s'] });
}

function Namespace({ name }: { name: string }) {
  return <span className="muted small">{name}</span>;
}

// ---------- Workloads ----------

function ScaleModal({ workload, onClose }: { workload: K8sWorkload; onClose: () => void }) {
  const [replicas, setReplicas] = useState(workload.desired);
  const [busy, setBusy] = useState(false);
  const { attempt } = useFeedback();
  const invalidate = useInvalidate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await attempt(`${workload.name} scaled to ${replicas}`, () =>
      endpoints.k8sScale(workload.kind, workload.namespace, workload.name, replicas),
    );
    setBusy(false);
    if (ok) {
      await invalidate();
      onClose();
    }
  };

  return (
    <Modal title={`Scale ${workload.name}`} size="sm" onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field">
          <span>Replicas</span>
          <input
            type="number"
            min={0}
            max={50}
            value={replicas}
            onChange={(e) => setReplicas(Number(e.target.value))}
            autoFocus
            required
          />
          <span className="muted small">
            Currently {workload.desired}. {replicas === 0 && 'Scaling to 0 stops the app until you scale it back up.'}
          </span>
        </label>
        <div className="form-foot">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            variant={replicas === 0 ? 'danger' : 'primary'}
            loading={busy}
            disabled={replicas === workload.desired}
          >
            {replicas === 0 ? 'Stop app' : 'Scale'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function Workloads({ filter }: { filter: Filter }) {
  const [scaling, setScaling] = useState<K8sWorkload | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, attempt } = useFeedback();
  const invalidate = useInvalidate();
  const workloads = useQuery({ queryKey: ['k8s', 'workloads'], queryFn: endpoints.k8sWorkloads, refetchInterval: 8000 });

  const restart = async (w: K8sWorkload) => {
    const ok = await confirm({
      title: `Restart ${w.name}?`,
      message:
        w.desired > 1
          ? 'Pods are replaced one at a time, so the app stays available during the restart.'
          : 'This app has a single pod. It may be briefly unavailable while the new pod starts.',
      confirmLabel: 'Restart',
    });
    if (!ok) return;
    const key = `${w.kind}/${w.namespace}/${w.name}`;
    setBusy(key);
    await attempt(`${w.name} is restarting`, () => endpoints.k8sRestart(w.kind, w.namespace, w.name));
    setBusy(null);
    await invalidate();
  };

  return (
    <>
      <QueryView query={workloads} empty={{ when: (d) => !d.length, title: 'No workloads' }}>
        {(data) => {
          const rows = data.filter((w) => visible(filter, w.namespace, w.name, ...w.images));
          if (!rows.length) return <div className="state muted">No workloads match.</div>;
          return (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>App</th>
                    <th>Type</th>
                    <th>Pods ready</th>
                    <th>Image</th>
                    <th>Created</th>
                    <th className="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((w) => {
                    const key = `${w.kind}/${w.namespace}/${w.name}`;
                    return (
                      <tr key={key}>
                        <td>
                          <strong>{w.name}</strong>
                          <div>
                            <Namespace name={w.namespace} />
                          </div>
                        </td>
                        <td>{KIND_LABEL[w.kind]}</td>
                        <td>
                          <Badge tone={workloadTone(w)}>
                            {w.desired === 0 ? 'Stopped' : `${w.ready} of ${w.desired}`}
                          </Badge>
                          {w.desired > 0 && w.updated < w.desired && <div className="muted small">Rolling out…</div>}
                        </td>
                        <td className="mono small">
                          {w.images.map((image) => (
                            <div key={image} className="clip" title={image}>
                              {image}
                            </div>
                          ))}
                        </td>
                        <td className="nowrap">{formatAgo(w.created)}</td>
                        <td className="actions">
                          <Button
                            size="sm"
                            icon={<RotateCw size={14} />}
                            title="Restart"
                            aria-label={`Restart ${w.name}`}
                            disabled={w.desired === 0}
                            loading={busy === key}
                            onClick={() => restart(w)}
                          />
                          <Button
                            size="sm"
                            icon={<Scaling size={14} />}
                            title={
                              w.scalable
                                ? 'Scale'
                                : w.kind === 'daemonset'
                                  ? 'DaemonSets cannot be scaled'
                                  : 'Protected namespace'
                            }
                            aria-label={`Scale ${w.name}`}
                            disabled={!w.scalable}
                            onClick={() => setScaling(w)}
                          />
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
      {scaling && <ScaleModal workload={scaling} onClose={() => setScaling(null)} />}
    </>
  );
}

// ---------- Pods ----------

function PodModal({ pod, onClose }: { pod: K8sPod; onClose: () => void }) {
  const [tab, setTab] = useState<'logs' | 'details'>('logs');
  const [container, setContainer] = useState(pod.containers[0]?.name ?? '');

  return (
    <Modal
      size="lg"
      onClose={onClose}
      title={
        <span className="row">
          {pod.name}
          <Badge tone={podTone(pod)}>{pod.status}</Badge>
        </span>
      }
    >
      <div className="toolbar">
        <Tabs
          tabs={[
            { id: 'logs', label: 'Logs' },
            { id: 'details', label: 'Details' },
          ]}
          value={tab}
          onChange={setTab}
        />
        {tab === 'logs' && pod.containers.length > 1 && (
          <label className="select">
            <span className="muted small">Container</span>
            <select value={container} onChange={(e) => setContainer(e.target.value)}>
              {pod.containers.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {tab === 'logs' ? (
        <LogViewer
          request={{ channel: 'pod-logs', namespace: pod.namespace, pod: pod.name, container, tail: 300 }}
          filename={`${pod.name}.log`}
        />
      ) : (
        <KeyValue
          items={[
            ['Namespace', pod.namespace],
            ['Status', pod.status],
            ['Containers ready', `${pod.ready} of ${pod.total}`],
            ['Restarts', pod.restarts],
            ['CPU', formatCpu(pod.cpuMilli)],
            ['Memory', formatBytes(pod.memory)],
            ['Pod IP', pod.ip ? <span className="mono">{pod.ip}</span> : null],
            ['Node', pod.node],
            ['Managed by', pod.owner],
            ['Created', formatDateTime(pod.created)],
            [
              'Images',
              <div className="stack mono small">
                {pod.containers.map((c) => (
                  <span key={c.name}>
                    {c.name}: {c.image}
                  </span>
                ))}
              </div>,
            ],
          ]}
        />
      )}
    </Modal>
  );
}

function Pods({ filter }: { filter: Filter }) {
  const [selected, setSelected] = useState<K8sPod | null>(null);
  const [hideCompleted, setHideCompleted] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const { confirm, attempt } = useFeedback();
  const invalidate = useInvalidate();
  const pods = useQuery({ queryKey: ['k8s', 'pods'], queryFn: endpoints.k8sPods, refetchInterval: 8000 });

  const remove = async (pod: K8sPod) => {
    const ok = await confirm({
      title: `Delete pod ${pod.name}?`,
      message: pod.owner
        ? `This pod is managed by a ${pod.owner}, so Kubernetes starts a replacement automatically. Use this to restart a single stuck pod.`
        : 'This pod is not managed by a controller. It will be deleted permanently and not recreated.',
      confirmLabel: 'Delete pod',
      danger: true,
    });
    if (!ok) return;
    const key = `${pod.namespace}/${pod.name}`;
    setBusy(key);
    await attempt(`Pod ${pod.name} deleted`, () => endpoints.k8sDeletePod(pod.namespace, pod.name));
    setBusy(null);
    await invalidate();
  };

  return (
    <>
      <div className="toolbar padded">
        <label className="check">
          <input type="checkbox" checked={hideCompleted} onChange={(e) => setHideCompleted(e.target.checked)} />
          Hide completed jobs
        </label>
      </div>
      <QueryView query={pods} empty={{ when: (d) => !d.length, title: 'No pods' }}>
        {(data) => {
          const rows = data.filter(
            (p) => (!hideCompleted || p.status !== 'Completed') && visible(filter, p.namespace, p.name, p.status),
          );
          if (!rows.length) return <div className="state muted">No pods match.</div>;
          return (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Pod</th>
                    <th>Status</th>
                    <th className="num">Ready</th>
                    <th className="num">Restarts</th>
                    <th className="num">CPU</th>
                    <th className="num">Memory</th>
                    <th>Age</th>
                    <th className="actions">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => {
                    const key = `${p.namespace}/${p.name}`;
                    return (
                      <tr key={key}>
                        <td>
                          <button type="button" className="link" onClick={() => setSelected(p)}>
                            {p.name}
                          </button>
                          <div>
                            <Namespace name={p.namespace} />
                          </div>
                        </td>
                        <td>
                          <Badge tone={podTone(p)}>{p.status}</Badge>
                        </td>
                        <td className="num">
                          {p.ready}/{p.total}
                        </td>
                        <td className="num">{p.restarts}</td>
                        <td className="num">{formatCpu(p.cpuMilli)}</td>
                        <td className="num">{formatBytes(p.memory)}</td>
                        <td className="nowrap">{formatAgo(p.created)}</td>
                        <td className="actions">
                          <Button
                            size="sm"
                            icon={<FileText size={14} />}
                            title="Logs and details"
                            aria-label={`Logs for ${p.name}`}
                            onClick={() => setSelected(p)}
                          />
                          <Button
                            size="sm"
                            variant="danger"
                            icon={<Trash2 size={14} />}
                            title="Delete pod"
                            aria-label={`Delete pod ${p.name}`}
                            loading={busy === key}
                            onClick={() => remove(p)}
                          />
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
      {selected && <PodModal pod={selected} onClose={() => setSelected(null)} />}
    </>
  );
}

// ---------- Ingresses ----------

function Ingresses({ filter }: { filter: Filter }) {
  const ingresses = useQuery({ queryKey: ['k8s', 'ingresses'], queryFn: endpoints.k8sIngresses, refetchInterval: 30_000 });
  return (
    <QueryView query={ingresses} empty={{ when: (d) => !d.length, title: 'No ingresses' }}>
      {(data) => {
        const rows = data.filter((i) => visible(filter, i.namespace, i.name, ...i.hosts.map((h) => h.host)));
        if (!rows.length) return <div className="state muted">No ingresses match.</div>;
        return (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Ingress</th>
                  <th>Addresses</th>
                  <th>Routes to</th>
                  <th>Certificate</th>
                  <th>Expires</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <tr key={`${i.namespace}/${i.name}`}>
                    <td>
                      <strong>{i.name}</strong>
                      <div>
                        <Namespace name={i.namespace} />
                      </div>
                    </td>
                    <td>
                      <div className="stack-tight">
                        {i.hosts.map((h) =>
                          h.host === '*' ? (
                            <span key={h.host} className="muted">
                              Any host
                            </span>
                          ) : (
                            <a
                              key={h.host}
                              className="ext"
                              href={`${h.tls ? 'https' : 'http'}://${h.host}`}
                              target="_blank"
                              rel="noreferrer"
                            >
                              {h.tls && <Lock size={12} />}
                              {h.host}
                              <ExternalLink size={12} />
                            </a>
                          ),
                        )}
                      </div>
                    </td>
                    <td className="mono small">{i.backends.join(', ')}</td>
                    <td>
                      {i.certificate === null ? (
                        <span className="muted">None</span>
                      ) : i.certificate.ready ? (
                        <Badge tone="good">Valid</Badge>
                      ) : (
                        <>
                          <Badge tone="critical">Not issued</Badge>
                          <div className="muted small wrap">{i.certificate.message}</div>
                        </>
                      )}
                    </td>
                    <td className="nowrap">
                      {i.certificate?.expires ? new Date(i.certificate.expires).toLocaleDateString() : '–'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }}
    </QueryView>
  );
}

// ---------- Events ----------

function Events({ filter }: { filter: Filter }) {
  const events = useQuery({ queryKey: ['k8s', 'events'], queryFn: endpoints.k8sEvents, refetchInterval: 15_000 });
  return (
    <QueryView
      query={events}
      empty={{
        when: (d) => !d.length,
        title: 'No warnings',
        hint: 'Kubernetes has reported no problems in the last hour.',
      }}
    >
      {(data) => {
        const rows = data.filter((e) => visible(filter, e.namespace, e.object, e.reason, e.message));
        if (!rows.length) return <div className="state muted">No warnings match.</div>;
        return (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Last seen</th>
                  <th>Object</th>
                  <th>Reason</th>
                  <th>Message</th>
                  <th className="num">Count</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((e, index) => (
                  <tr key={`${e.object}-${e.reason}-${index}`}>
                    <td className="nowrap">{formatAgo(e.lastSeen)}</td>
                    <td>
                      <span className="mono small">{e.object}</span>
                      <div>
                        <Namespace name={e.namespace} />
                      </div>
                    </td>
                    <td>
                      <Tag>{e.reason}</Tag>
                    </td>
                    <td className="wrap">{e.message}</td>
                    <td className="num">{e.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      }}
    </QueryView>
  );
}

// ---------- Page ----------

export function KubernetesPage() {
  const [tab, setTab] = useState<Tab>('workloads');
  const [namespace, setNamespace] = useState('');
  const [search, setSearch] = useState('');
  const caps = useQuery({ queryKey: ['capabilities'], queryFn: endpoints.capabilities, staleTime: Infinity });
  const enabled = caps.data?.kubernetes === true;
  const overview = useQuery({
    queryKey: ['k8s', 'overview'],
    queryFn: endpoints.k8sOverview,
    refetchInterval: 30_000,
    enabled,
  });
  const events = useQuery({ queryKey: ['k8s', 'events'], queryFn: endpoints.k8sEvents, refetchInterval: 15_000, enabled });
  const filter = useMemo(() => ({ namespace, search }), [namespace, search]);

  if (caps.data && !caps.data.kubernetes) {
    return (
      <>
        <PageHeader title="Kubernetes" />
        <Card>
          <EmptyState
            title="kubectl was not found on this host"
            hint="Kubernetes apps appear here when the panel runs on a server with k3s or kubectl installed."
          />
        </Card>
      </>
    );
  }

  const nodes = overview.data?.nodes ?? [];
  const notReady = nodes.filter((n) => !n.ready);

  return (
    <>
      <PageHeader
        title="Kubernetes"
        subtitle={
          nodes.length
            ? `${nodes.length} ${nodes.length === 1 ? 'node' : 'nodes'} · ${nodes[0].version} · ${nodes[0].os}`
            : undefined
        }
        actions={
          overview.data ? (
            notReady.length ? (
              <Badge tone="critical">
                {notReady.length} {notReady.length === 1 ? 'node' : 'nodes'} not ready
              </Badge>
            ) : (
              <Badge tone="good">Cluster ready</Badge>
            )
          ) : overview.error ? (
            <Badge tone="critical">Unreachable</Badge>
          ) : null
        }
      />
      <Card flush>
        <div className="toolbar padded">
          <Tabs
            tabs={[
              { id: 'workloads', label: 'Apps' },
              { id: 'pods', label: 'Pods' },
              { id: 'ingresses', label: 'Ingresses' },
              { id: 'events', label: 'Warnings', count: events.data?.length },
            ]}
            value={tab}
            onChange={setTab}
          />
          <span className="spacer" />
          <label className="select">
            <span className="muted small">Namespace</span>
            <select value={namespace} onChange={(e) => setNamespace(e.target.value)}>
              <option value="">All</option>
              {(overview.data?.namespaces ?? []).map((ns) => (
                <option key={ns} value={ns}>
                  {ns}
                </option>
              ))}
            </select>
          </label>
          <SearchInput value={search} onChange={setSearch} />
        </div>
        {!enabled ? (
          <div className="state muted">Loading…</div>
        ) : (
          <>
            {tab === 'workloads' && <Workloads filter={filter} />}
            {tab === 'pods' && <Pods filter={filter} />}
            {tab === 'ingresses' && <Ingresses filter={filter} />}
            {tab === 'events' && <Events filter={filter} />}
          </>
        )}
      </Card>
    </>
  );
}
