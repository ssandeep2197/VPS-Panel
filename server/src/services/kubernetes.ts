import { config } from '../config';
import { run, spawnStream } from '../utils/exec';
import { HttpError } from '../utils/http';

export const workloadKinds = ['deployment', 'statefulset', 'daemonset'] as const;
export type WorkloadKind = (typeof workloadKinds)[number];

const NAME_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

let available: boolean | null = null;

/** True when a kubectl binary exists on this host. Checked once. */
export async function isAvailable(): Promise<boolean> {
  if (available === null) {
    available = await run(config.kubectl, ['version', '--client'], { timeout: 5000 }).then(
      () => true,
      () => false,
    );
  }
  return available;
}

export function assertName(value: string, what = 'name'): string {
  if (!NAME_RE.test(value)) throw new HttpError(400, `Invalid ${what}`);
  return value;
}

function isProtected(namespace: string): boolean {
  return config.protectedNamespaces.includes(namespace);
}

async function kubectl(args: string[], timeout = 20_000): Promise<string> {
  try {
    return await run(config.kubectl, [...args, `--request-timeout=${Math.floor(timeout / 1000) - 2}s`], { timeout });
  } catch (err) {
    if (err instanceof HttpError && err.status === 500) {
      const message = err.message.replace(/^error:\s*/i, '').replace(/^Error from server \((\w+)\):\s*/, '');
      if (/NotFound/.test(err.message)) throw new HttpError(404, message);
      if (/connection refused|Unable to connect|was refused|no configuration|i\/o timeout/i.test(err.message)) {
        throw new HttpError(503, `Kubernetes API is not reachable: ${message}`, 'K8S_UNAVAILABLE');
      }
      throw new HttpError(500, message);
    }
    throw err;
  }
}

interface List<T> {
  items: T[];
}

async function getJson<T>(resource: string, extra: string[] = []): Promise<T[]> {
  const out = await kubectl(['get', resource, '-A', '-o', 'json', ...extra]);
  return (JSON.parse(out) as List<T>).items;
}

// ---------- Raw shapes (only the fields we read) ----------

interface Meta {
  name: string;
  namespace?: string;
  creationTimestamp: string;
  deletionTimestamp?: string;
  labels?: Record<string, string>;
  ownerReferences?: Array<{ kind: string; name: string }>;
}

interface Condition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

interface ContainerState {
  waiting?: { reason?: string; message?: string };
  terminated?: { reason?: string; exitCode: number };
  running?: { startedAt: string };
}

interface ContainerStatus {
  name: string;
  ready: boolean;
  restartCount: number;
  state?: ContainerState;
}

interface RawPod {
  metadata: Meta;
  spec: { nodeName?: string; containers: Array<{ name: string; image: string }> };
  status: {
    phase: string;
    reason?: string;
    podIP?: string;
    initContainerStatuses?: ContainerStatus[];
    containerStatuses?: ContainerStatus[];
  };
}

interface RawWorkload {
  kind: string;
  metadata: Meta;
  spec: { replicas?: number; template: { spec: { containers: Array<{ image: string }> } } };
  status: {
    replicas?: number;
    readyReplicas?: number;
    updatedReplicas?: number;
    desiredNumberScheduled?: number;
    numberReady?: number;
    updatedNumberScheduled?: number;
  };
}

interface RawIngress {
  metadata: Meta;
  status?: { loadBalancer?: { ingress?: Array<{ ip?: string; hostname?: string }> } };
  spec: {
    ingressClassName?: string;
    tls?: Array<{ hosts?: string[]; secretName?: string }>;
    rules?: Array<{
      host?: string;
      http?: { paths: Array<{ path?: string; backend: { service?: { name: string; port: { number?: number; name?: string } } } }> };
    }>;
  };
}

interface RawCertificate {
  metadata: Meta;
  spec: { secretName: string };
  status?: { conditions?: Condition[]; notAfter?: string };
}

interface RawEvent {
  metadata: Meta;
  type: string;
  reason: string;
  message: string;
  count?: number;
  lastTimestamp?: string;
  eventTime?: string;
  involvedObject: { kind: string; name: string; namespace?: string };
}

interface RawNode {
  metadata: Meta;
  status: { conditions?: Condition[]; nodeInfo: { kubeletVersion: string; osImage: string } };
}

export async function listNamespaces(): Promise<string[]> {
  const out = await kubectl(['get', 'namespaces', '-o', 'jsonpath={.items[*].metadata.name}']);
  return out.split(/\s+/).filter(Boolean);
}

// ---------- Overview ----------

export async function getOverview() {
  const [nodesOut, namespacesOut] = await Promise.all([
    kubectl(['get', 'nodes', '-o', 'json']),
    kubectl(['get', 'namespaces', '-o', 'json']),
  ]);
  const nodes = (JSON.parse(nodesOut) as List<RawNode>).items;
  const namespaces = (JSON.parse(namespacesOut) as List<{ metadata: Meta }>).items;
  return {
    nodes: nodes.map((n) => ({
      name: n.metadata.name,
      ready: n.status.conditions?.find((c) => c.type === 'Ready')?.status === 'True',
      version: n.status.nodeInfo.kubeletVersion,
      os: n.status.nodeInfo.osImage,
      roles: Object.keys(n.metadata.labels ?? {})
        .filter((l) => l.startsWith('node-role.kubernetes.io/'))
        .map((l) => l.split('/')[1]),
    })),
    namespaces: namespaces.map((n) => n.metadata.name).sort(),
    protectedNamespaces: config.protectedNamespaces,
  };
}

// ---------- Workloads ----------

export async function listWorkloads() {
  const items = await getJson<RawWorkload>('deployments,statefulsets,daemonsets');
  return items
    .map((w) => {
      const kind = w.kind.toLowerCase() as WorkloadKind;
      const daemon = kind === 'daemonset';
      const namespace = w.metadata.namespace ?? 'default';
      return {
        kind,
        namespace,
        name: w.metadata.name,
        desired: (daemon ? w.status.desiredNumberScheduled : w.spec.replicas) ?? 0,
        ready: (daemon ? w.status.numberReady : w.status.readyReplicas) ?? 0,
        updated: (daemon ? w.status.updatedNumberScheduled : w.status.updatedReplicas) ?? 0,
        images: w.spec.template.spec.containers.map((c) => c.image),
        created: w.metadata.creationTimestamp,
        scalable: !daemon && !isProtected(namespace),
      };
    })
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}

export async function restartWorkload(kind: WorkloadKind, namespace: string, name: string): Promise<void> {
  assertName(namespace, 'namespace');
  assertName(name);
  await kubectl(['rollout', 'restart', `${kind}/${name}`, '-n', namespace]);
}

export async function scaleWorkload(
  kind: WorkloadKind,
  namespace: string,
  name: string,
  replicas: number,
): Promise<void> {
  assertName(namespace, 'namespace');
  assertName(name);
  if (kind === 'daemonset') throw new HttpError(400, 'DaemonSets run one pod per node and cannot be scaled');
  if (isProtected(namespace)) {
    throw new HttpError(403, `Workloads in the ${namespace} namespace cannot be scaled from the panel`);
  }
  await kubectl(['scale', `${kind}/${name}`, '-n', namespace, `--replicas=${replicas}`]);
}

// ---------- Pods ----------

/** Mirrors the STATUS column of `kubectl get pods`. */
function podStatus(pod: RawPod): string {
  if (pod.metadata.deletionTimestamp) return 'Terminating';
  for (const c of pod.status.initContainerStatuses ?? []) {
    if (c.state?.terminated && c.state.terminated.exitCode === 0) continue;
    if (c.state?.waiting?.reason && c.state.waiting.reason !== 'PodInitializing') {
      return `Init:${c.state.waiting.reason}`;
    }
    if (c.state?.terminated) return `Init:${c.state.terminated.reason ?? 'Error'}`;
  }
  const statuses = pod.status.containerStatuses ?? [];
  for (const c of statuses) {
    if (c.state?.waiting?.reason) return c.state.waiting.reason;
  }
  for (const c of statuses) {
    if (c.state?.terminated && pod.status.phase !== 'Succeeded') return c.state.terminated.reason ?? 'Error';
  }
  if (pod.status.phase === 'Succeeded') return 'Completed';
  if (pod.status.phase === 'Running' && statuses.some((c) => !c.ready)) return 'NotReady';
  return pod.status.reason ?? pod.status.phase;
}

function parseCpu(value: string): number {
  if (value.endsWith('n')) return Number(value.slice(0, -1)) / 1e6;
  if (value.endsWith('u')) return Number(value.slice(0, -1)) / 1e3;
  if (value.endsWith('m')) return Number(value.slice(0, -1));
  return Number(value) * 1000;
}

function parseMemory(value: string): number {
  const match = /^(\d+(?:\.\d+)?)([A-Za-z]*)$/.exec(value);
  if (!match) return 0;
  const units: Record<string, number> = {
    '': 1,
    Ki: 1024,
    Mi: 1024 ** 2,
    Gi: 1024 ** 3,
    Ti: 1024 ** 4,
    k: 1e3,
    M: 1e6,
    G: 1e9,
  };
  return Number(match[1]) * (units[match[2]] ?? 1);
}

/** Usage from metrics-server, keyed by "namespace/pod". Empty when metrics are unavailable. */
async function podMetrics(): Promise<Map<string, { cpuMilli: number; memory: number }>> {
  const usage = new Map<string, { cpuMilli: number; memory: number }>();
  try {
    const out = await kubectl(['top', 'pods', '-A', '--no-headers'], 10_000);
    for (const line of out.split('\n')) {
      const [namespace, name, cpu, memory] = line.trim().split(/\s+/);
      if (memory) usage.set(`${namespace}/${name}`, { cpuMilli: parseCpu(cpu), memory: parseMemory(memory) });
    }
  } catch {
    // metrics-server missing or still warming up
  }
  return usage;
}

export async function listPods() {
  const [pods, metrics] = await Promise.all([getJson<RawPod>('pods'), podMetrics()]);
  return pods
    .map((p) => {
      const namespace = p.metadata.namespace ?? 'default';
      const statuses = p.status.containerStatuses ?? [];
      const usage = metrics.get(`${namespace}/${p.metadata.name}`);
      return {
        namespace,
        name: p.metadata.name,
        status: podStatus(p),
        phase: p.status.phase,
        ready: statuses.filter((c) => c.ready).length,
        total: p.spec.containers.length,
        restarts: statuses.reduce((sum, c) => sum + c.restartCount, 0),
        containers: p.spec.containers.map((c) => ({ name: c.name, image: c.image })),
        owner: p.metadata.ownerReferences?.[0]?.kind ?? null,
        node: p.spec.nodeName ?? null,
        ip: p.status.podIP ?? null,
        created: p.metadata.creationTimestamp,
        cpuMilli: usage?.cpuMilli ?? null,
        memory: usage?.memory ?? null,
      };
    })
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}

export async function deletePod(namespace: string, name: string): Promise<void> {
  assertName(namespace, 'namespace');
  assertName(name);
  await kubectl(['delete', 'pod', name, '-n', namespace, '--wait=false']);
}

export function followPodLogs(namespace: string, pod: string, container: string | undefined, tail: number) {
  assertName(namespace, 'namespace');
  assertName(pod, 'pod name');
  const args = ['logs', pod, '-n', namespace, '-f', '--timestamps', `--tail=${tail}`];
  if (container) args.push('-c', assertName(container, 'container name'));
  return spawnStream(config.kubectl, args);
}

// ---------- Ingresses ----------

export async function listIngresses() {
  const [ingresses, certificates] = await Promise.all([
    getJson<RawIngress>('ingresses.networking.k8s.io'),
    // cert-manager is optional
    getJson<RawCertificate>('certificates.cert-manager.io').catch(() => [] as RawCertificate[]),
  ]);
  const certBySecret = new Map(
    certificates.map((c) => {
      const ready = c.status?.conditions?.find((x) => x.type === 'Ready');
      return [
        `${c.metadata.namespace}/${c.spec.secretName}`,
        { ready: ready?.status === 'True', message: ready?.message ?? '', expires: c.status?.notAfter ?? null },
      ] as const;
    }),
  );

  return ingresses
    .map((i) => {
      const namespace = i.metadata.namespace ?? 'default';
      const tlsHosts = new Set((i.spec.tls ?? []).flatMap((t) => t.hosts ?? []));
      const certs = (i.spec.tls ?? [])
        .map((t) => (t.secretName ? certBySecret.get(`${namespace}/${t.secretName}`) : undefined))
        .filter((c) => c !== undefined);
      return {
        namespace,
        name: i.metadata.name,
        className: i.spec.ingressClassName ?? null,
        hosts: (i.spec.rules ?? []).map((r) => ({ host: r.host ?? '*', tls: tlsHosts.has(r.host ?? '') })),
        backends: [
          ...new Set(
            (i.spec.rules ?? []).flatMap((r) =>
              (r.http?.paths ?? []).map((p) =>
                p.backend.service
                  ? `${p.backend.service.name}:${p.backend.service.port.number ?? p.backend.service.port.name}`
                  : 'resource',
              ),
            ),
          ),
        ],
        // null = no cert-manager certificate is attached to this ingress
        certificate: certs.length
          ? {
              ready: certs.every((c) => c.ready),
              message: certs.find((c) => !c.ready)?.message ?? '',
              expires: certs.map((c) => c.expires).filter((e): e is string => Boolean(e)).sort()[0] ?? null,
            }
          : null,
        created: i.metadata.creationTimestamp,
        /** Public address the ingress controller reports (the server's IP). */
        address: i.status?.loadBalancer?.ingress?.[0]?.ip ?? i.status?.loadBalancer?.ingress?.[0]?.hostname ?? null,
      };
    })
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}

// ---------- Endpoints ----------

interface RawEndpoints {
  metadata: Meta;
  subsets?: Array<{
    addresses?: Array<{ ip: string; targetRef?: { kind: string; name: string } }>;
    notReadyAddresses?: Array<{ ip: string; targetRef?: { kind: string; name: string } }>;
    ports?: Array<{ name?: string; port: number }>;
  }>;
}

export interface ServiceEndpoints {
  namespace: string;
  name: string;
  ready: Array<{ ip: string; port: number; pod: string | null }>;
  notReady: Array<{ ip: string; pod: string | null }>;
}

/** Ready and not-ready addresses behind every Service (pods, or static addresses for selector-less services). */
export async function listEndpoints(): Promise<ServiceEndpoints[]> {
  const items = await getJson<RawEndpoints>('endpoints');
  return items.map((e) => {
    const ready: ServiceEndpoints['ready'] = [];
    const notReady: ServiceEndpoints['notReady'] = [];
    for (const subset of e.subsets ?? []) {
      const ports = subset.ports?.length ? subset.ports : [{ port: 0 }];
      for (const a of subset.addresses ?? []) {
        for (const p of ports) ready.push({ ip: a.ip, port: p.port, pod: a.targetRef?.kind === 'Pod' ? a.targetRef.name : null });
      }
      for (const a of subset.notReadyAddresses ?? []) {
        notReady.push({ ip: a.ip, pod: a.targetRef?.kind === 'Pod' ? a.targetRef.name : null });
      }
    }
    return { namespace: e.metadata.namespace ?? 'default', name: e.metadata.name, ready, notReady };
  });
}

// ---------- Events ----------

export async function listWarnings() {
  const events = await getJson<RawEvent>('events', ['--field-selector', 'type=Warning']);
  return events
    .map((e) => ({
      namespace: e.involvedObject.namespace ?? e.metadata.namespace ?? '',
      object: `${e.involvedObject.kind}/${e.involvedObject.name}`,
      reason: e.reason,
      message: e.message,
      count: e.count ?? 1,
      lastSeen: e.lastTimestamp ?? e.eventTime ?? e.metadata.creationTimestamp,
    }))
    .sort((a, b) => Date.parse(b.lastSeen) - Date.parse(a.lastSeen))
    .slice(0, 200);
}
