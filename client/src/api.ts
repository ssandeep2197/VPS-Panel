const TOKEN_KEY = 'vps_panel_token';
export const LOGOUT_EVENT = 'vps-panel:logout';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable (private mode): the session lasts until reload
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
}

export async function api<T>(path: string, { method = 'GET', body }: RequestOptions = {}): Promise<T> {
  const token = getToken();
  const res = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      // Marks the request as the panel's own page (cookie sessions refuse state changes without it)
      'X-Requested-With': 'vps-panel',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    // empty or non-JSON body
  }

  if (!res.ok) {
    const payload = (data ?? {}) as { error?: string; code?: string };
    if (res.status === 401 && payload.code === 'UNAUTHENTICATED') {
      setToken(null);
      // The start-up "who am I" probe and sign-out itself answer 401 when nobody is signed in; that is not a
      // session ending, and the sign-out it would trigger clears the query cache under the login page
      if (path !== '/auth/me' && path !== '/auth/logout') window.dispatchEvent(new Event(LOGOUT_EVENT));
    }
    throw new ApiError(res.status, payload.error || `Request failed (${res.status})`, payload.code);
  }
  return data as T;
}

const enc = encodeURIComponent;

export interface AuthMode {
  /** Sign in with TMS (OpenID Connect) is on. */
  tms: boolean;
  /** The panel's own admin password login is on (the fallback for when TMS is down). */
  legacy: boolean;
  issuer: string | null;
  /** Where the browser goes to start the TMS sign-in. */
  loginUrl: string | null;
}

export interface Me {
  username: string;
  via: 'token' | 'tms';
  sub: string | null;
  name: string;
  role: string | null;
  canWrite: boolean;
  expiresAt: string;
}

// ---------- Types ----------

export interface Capabilities {
  systemd: boolean;
  kafka: boolean;
  kubernetes: boolean;
  platform: string;
}

export interface Disk {
  fs: string;
  type: string;
  mount: string;
  size: number;
  used: number;
  usePercent: number;
}

export interface Overview {
  hostname: string;
  platform: string;
  distro: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cpuCores: number;
  uptime: number;
  disks: Disk[];
}

export interface MetricSample {
  ts: number;
  cpu: number;
  memUsed: number;
  memTotal: number;
  swapUsed: number;
  swapTotal: number;
  load: [number, number, number];
  rxSec: number;
  txSec: number;
}

export interface ProcessRow {
  pid: number;
  parentPid: number;
  name: string;
  user: string;
  cpu: number;
  mem: number;
  memRss: number;
  state: string;
  started: string;
  command: string;
}

export interface ProcessList {
  total: number;
  running: number;
  sleeping: number;
  list: ProcessRow[];
}

export interface PortRow {
  protocol: string;
  address: string;
  port: number;
  pid: number | null;
  process: string;
}

export interface AuditEntry {
  ts: string;
  user: string;
  ip: string;
  action: string;
  target: string;
  ok: boolean;
  detail?: string;
}

export interface ServiceUnit {
  name: string;
  description: string;
  load: string;
  active: string;
  sub: string;
  enabled: string;
  protected: boolean;
}

export interface ServiceDetail extends ServiceUnit {
  mainPid: number | null;
  memoryBytes: number | null;
  cpuSeconds: number | null;
  tasks: number | null;
  restarts: number | null;
  restartPolicy: string;
  activeSince: string;
  unitFile: string;
  execStart: string;
  user: string;
}

export type ServiceAction = 'start' | 'stop' | 'restart' | 'reload' | 'enable' | 'disable';

export interface DockerInfo {
  version: string;
  apiVersion: string;
  os: string;
  containers: number;
  running: number;
  paused: number;
  stopped: number;
  images: number;
  cpus: number;
  memTotal: number;
  storageDriver: string;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  created: number;
  project: string | null;
  ports: string[];
}

export interface ContainerDetail {
  id: string;
  name: string;
  image: string;
  created: string;
  state: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  health: string | null;
  restartCount: number;
  restartPolicy: string;
  command: string;
  envNames: string[];
  mounts: Array<{ type: string; source: string; destination: string; rw: boolean }>;
  networks: Array<{ name: string; ip: string }>;
  ports: string[];
}

export interface ContainerStats {
  cpu: number;
  memUsed: number;
  memLimit: number;
  netRx: number;
  netTx: number;
}

export type ContainerAction = 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill';

export interface DockerImage {
  id: string;
  tags: string[];
  size: number;
  created: number;
  inUse: boolean;
}

export interface DockerVolume {
  name: string;
  driver: string;
  mountpoint: string;
  created: string | null;
  usedBy: string[];
}

export interface DockerNetwork {
  id: string;
  name: string;
  driver: string;
  scope: string;
  subnet: string | null;
  internal: boolean;
}

export interface KafkaCluster {
  clusterId: string;
  controller: number | null;
  bootstrap: string[];
  brokers: Array<{ nodeId: number; host: string; port: number; isController: boolean }>;
}

export interface KafkaTopic {
  name: string;
  internal: boolean;
  partitions: number;
  replicationFactor: number;
  underReplicated: number;
  messages: number;
}

export interface KafkaTopicDetail {
  name: string;
  messages: number;
  partitions: Array<{
    partition: number;
    leader: number;
    replicas: number[];
    isr: number[];
    low: string;
    high: string;
  }>;
  config: Array<{ name: string; value: string; isDefault: boolean }>;
}

export interface KafkaMessage {
  partition: number;
  offset: string;
  timestamp: string;
  key: string | null;
  value: string | null;
  truncated: boolean;
}

export interface KafkaGroup {
  groupId: string;
  state: string;
  protocol: string;
  members: number;
}

export interface KafkaGroupDetail {
  groupId: string;
  state: string;
  protocol: string;
  members: Array<{ memberId: string; clientId: string; host: string }>;
  offsets: Array<{
    topic: string;
    partition: number;
    committed: string | null;
    end: string | null;
    lag: number | null;
  }>;
  totalLag: number;
}

export interface K8sOverview {
  nodes: Array<{ name: string; ready: boolean; version: string; os: string; roles: string[] }>;
  namespaces: string[];
  protectedNamespaces: string[];
}

export interface K8sWorkload {
  kind: 'deployment' | 'statefulset' | 'daemonset';
  namespace: string;
  name: string;
  desired: number;
  ready: number;
  updated: number;
  images: string[];
  created: string;
  scalable: boolean;
}

export interface K8sPod {
  namespace: string;
  name: string;
  status: string;
  phase: string;
  ready: number;
  total: number;
  restarts: number;
  containers: Array<{ name: string; image: string }>;
  owner: string | null;
  node: string | null;
  ip: string | null;
  created: string;
  cpuMilli: number | null;
  memory: number | null;
}

export interface K8sIngress {
  namespace: string;
  name: string;
  className: string | null;
  hosts: Array<{ host: string; tls: boolean }>;
  backends: string[];
  certificate: { ready: boolean; message: string; expires: string | null } | null;
  created: string;
}

export interface K8sEvent {
  namespace: string;
  object: string;
  reason: string;
  message: string;
  count: number;
  lastSeen: string;
}

export interface AccessEntry {
  id: string;
  ts: number;
  client: string;
  host: string;
  method: string;
  path: string;
  protocol: string;
  status: number;
  bytes: number;
  duration: number;
  referer: string;
  userAgent: string;
  namespace: string;
  service: string;
  upstream: string;
  upstreamStatus: number | null;
}

export type SiteStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export interface SiteBackend {
  service: string;
  kind: 'pods' | 'external' | 'missing';
  ready: number;
  total: number;
  addresses: string[];
  reachable: boolean | null;
  pods: Array<{ name: string; status: string; restarts: number; image: string }>;
  container: { name: string; state: string; status: string; image: string } | null;
}

export interface SiteCheck {
  host: string;
  url: string;
  name: string;
  namespace: string | null;
  ingress: string | null;
  status: SiteStatus;
  problems: string[];
  notes: string[];
  dns: { addresses: string[]; pointsHere: boolean | null };
  tls: {
    valid: boolean;
    placeholder: boolean;
    issuer: string | null;
    subject: string | null;
    expires: string | null;
    daysLeft: number | null;
    error: string | null;
  };
  certificate: { ready: boolean; message: string; expires: string | null } | null;
  http: {
    status: number | null;
    latencyMs: number | null;
    title: string | null;
    finalUrl: string | null;
    server: string | null;
    error: string | null;
  };
  backends: SiteBackend[];
  thumbnailAt: string | null;
  checkedAt: string;
}

export interface SitesReport {
  checkedAt: string | null;
  publicIp: string | null;
  thumbnails: boolean;
  discovery: string | null;
  sites: SiteCheck[];
}

/** Fetches a protected binary resource (the <img> tag cannot send the bearer token). */
export async function apiBlob(path: string): Promise<Blob> {
  const token = getToken();
  const res = await fetch(`/api${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!res.ok) throw new ApiError(res.status, `Request failed (${res.status})`);
  return res.blob();
}

// ---------- Endpoints ----------

export const endpoints = {
  login: (username: string, password: string) =>
    api<{ token: string; username: string }>('/auth/login', { method: 'POST', body: { username, password } }),
  me: () => api<Me>('/auth/me'),
  authMode: () => api<AuthMode>('/auth/mode'),
  logout: () => api<{ ok: true; logoutUrl: string | null }>('/auth/logout', { method: 'POST' }),
  capabilities: () => api<Capabilities>('/capabilities'),

  overview: () => api<Overview>('/system/overview'),
  processes: () => api<ProcessList>('/system/processes'),
  killProcess: (pid: number, signal: string) =>
    api<{ ok: true }>(`/system/processes/${pid}/kill`, { method: 'POST', body: { signal } }),
  ports: () => api<PortRow[]>('/system/ports'),
  audit: () => api<AuditEntry[]>('/system/audit?limit=500'),

  services: () => api<ServiceUnit[]>('/services'),
  service: (name: string) => api<ServiceDetail>(`/services/${enc(name)}`),
  serviceAction: (name: string, action: ServiceAction) =>
    api<ServiceDetail>(`/services/${enc(name)}/${action}`, { method: 'POST' }),

  dockerInfo: () => api<DockerInfo>('/docker/info'),
  containers: () => api<Container[]>('/docker/containers'),
  containerStats: () => api<Record<string, ContainerStats>>('/docker/stats'),
  container: (id: string) => api<ContainerDetail>(`/docker/containers/${enc(id)}`),
  containerAction: (id: string, action: ContainerAction, name: string) =>
    api<{ ok: true }>(`/docker/containers/${enc(id)}/${action}`, { method: 'POST', body: { name } }),
  removeContainer: (id: string, force: boolean) =>
    api<{ ok: true }>(`/docker/containers/${enc(id)}?force=${force ? 1 : 0}`, { method: 'DELETE' }),
  images: () => api<DockerImage[]>('/docker/images'),
  pullImage: (image: string) => api<{ ok: true }>('/docker/images/pull', { method: 'POST', body: { image } }),
  removeImage: (id: string, force: boolean) =>
    api<{ ok: true }>(`/docker/images/${enc(id)}?force=${force ? 1 : 0}`, { method: 'DELETE' }),
  volumes: () => api<DockerVolume[]>('/docker/volumes'),
  removeVolume: (name: string) => api<{ ok: true }>(`/docker/volumes/${enc(name)}`, { method: 'DELETE' }),
  networks: () => api<DockerNetwork[]>('/docker/networks'),

  k8sOverview: () => api<K8sOverview>('/kubernetes/overview'),
  k8sWorkloads: () => api<K8sWorkload[]>('/kubernetes/workloads'),
  k8sRestart: (kind: string, namespace: string, name: string) =>
    api<{ ok: true }>(`/kubernetes/workloads/${kind}/${enc(namespace)}/${enc(name)}/restart`, { method: 'POST' }),
  k8sScale: (kind: string, namespace: string, name: string, replicas: number) =>
    api<{ ok: true }>(`/kubernetes/workloads/${kind}/${enc(namespace)}/${enc(name)}/scale`, {
      method: 'POST',
      body: { replicas },
    }),
  k8sPods: () => api<K8sPod[]>('/kubernetes/pods'),
  k8sDeletePod: (namespace: string, name: string) =>
    api<{ ok: true }>(`/kubernetes/pods/${enc(namespace)}/${enc(name)}`, { method: 'DELETE' }),
  k8sIngresses: () => api<K8sIngress[]>('/kubernetes/ingresses'),
  k8sEvents: () => api<K8sEvent[]>('/kubernetes/events'),

  sites: () => api<SitesReport>('/sites'),
  refreshSites: () => api<SitesReport>('/sites/refresh', { method: 'POST' }),
  siteThumbnail: (host: string) => apiBlob(`/sites/${enc(host)}/thumbnail`),
  captureSiteThumbnail: (host: string) =>
    api<{ ok: true; thumbnailAt: string }>(`/sites/${enc(host)}/thumbnail`, { method: 'POST' }),

  kafkaCluster: () => api<KafkaCluster>('/kafka/cluster'),
  kafkaTopics: () => api<KafkaTopic[]>('/kafka/topics'),
  kafkaTopic: (name: string) => api<KafkaTopicDetail>(`/kafka/topics/${enc(name)}`),
  createTopic: (body: { name: string; partitions: number; replicationFactor: number }) =>
    api<{ ok: true }>('/kafka/topics', { method: 'POST', body }),
  deleteTopic: (name: string) => api<{ ok: true }>(`/kafka/topics/${enc(name)}`, { method: 'DELETE' }),
  kafkaMessages: (name: string, limit: number) =>
    api<KafkaMessage[]>(`/kafka/topics/${enc(name)}/messages?limit=${limit}`),
  produce: (name: string, key: string | null, value: string) =>
    api<{ ok: true }>(`/kafka/topics/${enc(name)}/messages`, { method: 'POST', body: { key, value } }),
  kafkaGroups: () => api<KafkaGroup[]>('/kafka/groups'),
  kafkaGroup: (id: string) => api<KafkaGroupDetail>(`/kafka/groups/${enc(id)}`),
  deleteGroup: (id: string) => api<{ ok: true }>(`/kafka/groups/${enc(id)}`, { method: 'DELETE' }),
};
