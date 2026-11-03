import dns from 'dns/promises';
import fs from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import { Writable } from 'stream';
import tls from 'tls';
import type Dockerode from 'dockerode';
import { config } from '../config';
import { errorMessage } from '../utils/http';
import { docker, listContainers, pullImage } from './docker';
import { isAvailable as kubernetesAvailable, listEndpoints, listIngresses, listPods, type ServiceEndpoints } from './kubernetes';

/**
 * Health checks for every hostname the server fronts. Sites are discovered from the cluster's
 * ingress rules (plus SITES from .env) and checked from the server itself: DNS, the certificate
 * actually served, the HTTPS response and the backend behind the ingress. Each failing step is
 * explained in plain words in `problems`.
 */

export type SiteStatus = 'ok' | 'degraded' | 'down' | 'unknown';

export interface BackendPod {
  name: string;
  status: string;
  restarts: number;
  image: string;
}

export interface SiteBackend {
  service: string;
  /** pods = Service with a selector; external = selector-less Service pointing at a host port (Docker). */
  kind: 'pods' | 'external' | 'missing';
  ready: number;
  total: number;
  addresses: string[];
  reachable: boolean | null;
  pods: BackendPod[];
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

const CHECK_INTERVAL_MS = 60_000;
const THUMBNAIL_MAX_AGE_MS = 30 * 60_000;
const THUMBNAILS_PER_CYCLE = 3;
const HTTP_TIMEOUT_MS = 10_000;
const TLS_TIMEOUT_MS = 8_000;
const PLACEHOLDER_CN = 'Kubernetes Ingress Controller Fake Certificate';
const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)+$/i;

/** Public resolvers: the server's own resolver may have hosts-file or cluster overrides that visitors never see. */
const publicResolver = new dns.Resolver({ timeout: 4000, tries: 2 });
publicResolver.setServers(['1.1.1.1', '8.8.8.8']);

async function resolvePublic(host: string): Promise<{ addresses: string[]; error: string | null; viaSystem: boolean }> {
  try {
    return { addresses: await publicResolver.resolve4(host), error: null, viaSystem: false };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    if (code === 'ENOTFOUND' || code === 'ENODATA') return { addresses: [], error: code, viaSystem: false };
    // Public resolvers unreachable (firewall): fall back to the system resolver
    try {
      return { addresses: await dns.resolve4(host), error: null, viaSystem: true };
    } catch (err2) {
      return { addresses: [], error: (err2 as NodeJS.ErrnoException).code ?? errorMessage(err2), viaSystem: true };
    }
  }
}

const thumbDir = path.join(config.dataDir, 'thumbnails');
fs.mkdirSync(thumbDir, { recursive: true });

let report: SitesReport = { checkedAt: null, publicIp: config.sites.publicIp || null, thumbnails: config.sites.thumbnails, discovery: null, sites: [] };
let timer: NodeJS.Timeout | null = null;
let running: Promise<SitesReport> | null = null;

export function assertHost(host: string): string {
  if (!HOST_RE.test(host) || host.length > 253) throw new Error('Invalid hostname');
  return host.toLowerCase();
}

// ---------- Low level probes ----------

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  finalUrl: string;
  latencyMs: number;
}

/** GET with redirects, a body cap and a lenient TLS policy (the certificate is judged separately). */
function httpGet(url: string, redirects = 5, started = Date.now()): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(
      target,
      {
        method: 'GET',
        timeout: HTTP_TIMEOUT_MS,
        rejectUnauthorized: false,
        headers: { 'User-Agent': 'vps-panel-sitecheck/1.0', Accept: 'text/html,*/*' },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location && redirects > 0) {
          res.resume();
          resolve(httpGet(new URL(location, target).toString(), redirects - 1, started));
          return;
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          if (body.length < 65_536) body += chunk;
          else res.destroy();
        });
        res.on('end', () => resolve({ status, headers: res.headers, body, finalUrl: target.toString(), latencyMs: Date.now() - started }));
        res.on('close', () => resolve({ status, headers: res.headers, body, finalUrl: target.toString(), latencyMs: Date.now() - started }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error(`No response within ${HTTP_TIMEOUT_MS / 1000}s`)));
    req.on('error', reject);
    req.end();
  });
}

function tlsProbe(host: string): Promise<SiteCheck['tls']> {
  return new Promise((resolve) => {
    const result: SiteCheck['tls'] = { valid: false, placeholder: false, issuer: null, subject: null, expires: null, daysLeft: null, error: null };
    const socket = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false, timeout: TLS_TIMEOUT_MS }, () => {
      const cert = socket.getPeerCertificate();
      if (cert && cert.subject) {
        const issuer = cert.issuer ?? {};
        const one = (v: string | string[] | undefined): string | null => (Array.isArray(v) ? v[0] ?? null : v ?? null);
        result.subject = one(cert.subject.CN);
        result.issuer = [one(issuer.O), one(issuer.CN)].filter(Boolean).join(' ') || null;
        result.expires = cert.valid_to ? new Date(cert.valid_to).toISOString() : null;
        result.daysLeft = cert.valid_to ? Math.floor((Date.parse(cert.valid_to) - Date.now()) / 86_400_000) : null;
        result.placeholder = one(cert.subject.CN) === PLACEHOLDER_CN || one(issuer.CN) === PLACEHOLDER_CN;
      }
      result.valid = socket.authorized;
      if (!socket.authorized) result.error = socket.authorizationError ? String(socket.authorizationError) : 'not trusted';
      socket.end();
      resolve(result);
    });
    socket.on('timeout', () => {
      result.error = 'TLS handshake timed out';
      socket.destroy();
      resolve(result);
    });
    socket.on('error', (err) => {
      result.error = err.message;
      resolve(result);
    });
  });
}

function tcpProbe(ip: string, port: number, timeout = 3000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: ip, port, timeout });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function pageTitle(body: string): string | null {
  const m = /<title[^>]*>([^<]{0,200})<\/title>/i.exec(body);
  return m ? m[1].replace(/\s+/g, ' ').trim() || null : null;
}

// ---------- Discovery ----------

interface Discovered {
  host: string;
  name: string;
  namespace: string | null;
  ingress: string | null;
  tlsConfigured: boolean;
  certificate: SiteCheck['certificate'];
  backends: string[];
}

async function discover(): Promise<{ sites: Discovered[]; publicIp: string | null; error: string | null }> {
  const byHost = new Map<string, Discovered>();
  let publicIp = config.sites.publicIp || null;
  let error: string | null = null;
  if (await kubernetesAvailable()) {
    try {
      for (const ing of await listIngresses()) {
        if (!publicIp && ing.address) publicIp = ing.address;
        for (const h of ing.hosts) {
          if (h.host === '*' || byHost.has(h.host)) continue;
          byHost.set(h.host, {
            host: h.host,
            name: ing.name,
            namespace: ing.namespace,
            ingress: ing.name,
            tlsConfigured: h.tls,
            certificate: ing.certificate,
            backends: ing.backends.map((b) => b.split(':')[0]),
          });
        }
      }
    } catch (err) {
      error = `Could not read ingresses: ${errorMessage(err).split('\n').pop()?.trim() ?? 'unknown error'}. Only hosts from SITES in .env are checked.`;
    }
  } else {
    error = 'Kubernetes is not available: only hosts from SITES in .env are checked';
  }
  for (const host of config.sites.extra) {
    if (!byHost.has(host)) {
      byHost.set(host, { host, name: host, namespace: null, ingress: null, tlsConfigured: true, certificate: null, backends: [] });
    }
  }
  return { sites: [...byHost.values()].sort((a, b) => a.host.localeCompare(b.host)), publicIp, error };
}

// ---------- Checking ----------

interface Context {
  publicIp: string | null;
  endpoints: Map<string, ServiceEndpoints>;
  pods: Map<string, BackendPod>;
  containersByPort: Map<string, SiteBackend['container']>;
}

async function buildContext(publicIp: string | null): Promise<Context> {
  const ctx: Context = { publicIp, endpoints: new Map(), pods: new Map(), containersByPort: new Map() };
  const [endpoints, pods, containers] = await Promise.all([
    listEndpoints().catch(() => [] as ServiceEndpoints[]),
    listPods().catch(() => []),
    listContainers().catch(() => []),
  ]);
  for (const e of endpoints) ctx.endpoints.set(`${e.namespace}/${e.name}`, e);
  for (const p of pods) {
    ctx.pods.set(`${p.namespace}/${p.name}`, { name: p.name, status: p.status, restarts: p.restarts, image: p.containers[0]?.image ?? '' });
  }
  for (const c of containers) {
    for (const port of c.ports) {
      // "172.17.0.1:3110->3000/tcp" -> key "172.17.0.1:3110"
      const m = /^([\d.]+):(\d+)->/.exec(port);
      if (m) ctx.containersByPort.set(`${m[1]}:${m[2]}`, { name: c.name, state: c.state, status: c.status, image: c.image });
    }
  }
  return ctx;
}

async function checkBackend(namespace: string, service: string, ctx: Context): Promise<SiteBackend> {
  const ep = ctx.endpoints.get(`${namespace}/${service}`);
  if (!ep) {
    return { service, kind: 'missing', ready: 0, total: 0, addresses: [], reachable: null, pods: [], container: null };
  }
  const podNames = [...new Set([...ep.ready, ...ep.notReady].map((a) => a.pod).filter((p): p is string => Boolean(p)))];
  if (podNames.length) {
    const pods = podNames.map((n) => ctx.pods.get(`${namespace}/${n}`) ?? { name: n, status: 'Unknown', restarts: 0, image: '' });
    const readyPods = new Set(ep.ready.map((a) => a.pod));
    return {
      service,
      kind: 'pods',
      ready: readyPods.size,
      total: podNames.length,
      addresses: [],
      reachable: null,
      pods,
      container: null,
    };
  }
  // Selector-less service: static addresses, typically a Docker container on the host bridge
  const addresses = [...new Set(ep.ready.map((a) => `${a.ip}:${a.port}`))];
  const probes = await Promise.all(addresses.slice(0, 3).map((a) => tcpProbe(a.split(':')[0], Number(a.split(':')[1]))));
  const container = addresses.map((a) => ctx.containersByPort.get(a)).find((c) => c) ?? null;
  return {
    service,
    kind: 'external',
    ready: probes.filter(Boolean).length,
    total: addresses.length,
    addresses,
    reachable: addresses.length ? probes.every(Boolean) : null,
    pods: [],
    container,
  };
}

async function checkSite(site: Discovered, ctx: Context, thumbnailAt: string | null): Promise<SiteCheck> {
  const url = `https://${site.host}/`;
  const problems: string[] = [];
  const notes: string[] = [];

  const [dnsResult, tlsResult, httpResult, backends] = await Promise.all([
    resolvePublic(site.host),
    tlsProbe(site.host),
    httpGet(url).then(
      (r) => ({ ...r, error: null as string | null }),
      (err: Error) => ({
        status: null,
        headers: {} as http.IncomingHttpHeaders,
        body: '',
        finalUrl: null,
        latencyMs: null,
        error: err.message,
      }),
    ),
    Promise.all(site.backends.map((b) => checkBackend(site.namespace ?? 'default', b, ctx))),
  ]);

  // DNS
  const pointsHere = ctx.publicIp ? dnsResult.addresses.includes(ctx.publicIp) : null;
  if (!dnsResult.addresses.length) {
    problems.push(`DNS: ${site.host} has no A record (${dnsResult.error ?? 'no answer'}). Add an A record pointing to ${ctx.publicIp ?? 'this server'}.`);
  } else if (pointsHere === false && dnsResult.viaSystem) {
    notes.push(`Resolves to ${dnsResult.addresses.join(', ')} on this server (local override); public DNS could not be queried.`);
  } else if (pointsHere === false) {
    problems.push(`DNS points to ${dnsResult.addresses.join(', ')}, not to this server (${ctx.publicIp}). Visitors reach a different machine.`);
  }

  // Backends
  for (const b of backends) {
    if (b.kind === 'missing') {
      problems.push(`Service "${b.service}" has no endpoints: it does not exist or nothing is behind it.`);
    } else if (b.kind === 'pods' && b.ready === 0) {
      const bad = b.pods.map((p) => `${p.name} is ${p.status}${p.restarts ? ` (${p.restarts} restarts)` : ''}`).join('; ');
      problems.push(`No ready pods behind service "${b.service}"${bad ? `: ${bad}` : ''}.`);
    } else if (b.kind === 'pods' && b.ready < b.total) {
      notes.push(`${b.ready} of ${b.total} pods ready behind "${b.service}".`);
    } else if (b.kind === 'external' && b.reachable === false) {
      const c = b.container;
      problems.push(
        c
          ? `Container "${c.name}" is ${c.state} (${c.status}); nothing accepts connections on ${b.addresses.join(', ')}.`
          : `Nothing accepts connections on ${b.addresses.join(', ')}. The app behind the ingress is not running.`,
      );
    }
  }

  // Certificate
  if (site.certificate && !site.certificate.ready) {
    problems.push(`Certificate not issued yet: ${site.certificate.message || 'cert-manager is still working on it'}.`);
  }
  if (tlsResult.error && !tlsResult.subject) {
    problems.push(`HTTPS handshake failed: ${tlsResult.error}.`);
  } else if (tlsResult.placeholder) {
    problems.push(
      site.ingress
        ? 'Serving the ingress placeholder certificate: the TLS secret for this host does not exist yet.'
        : 'Serving the ingress placeholder certificate: no ingress rule has a certificate for this host.',
    );
  } else if (!tlsResult.valid) {
    problems.push(`Browsers will not trust the certificate (${tlsResult.error}).`);
  } else if (tlsResult.daysLeft !== null && tlsResult.daysLeft < 0) {
    problems.push('The certificate has expired.');
  } else if (tlsResult.daysLeft !== null && tlsResult.daysLeft < 14) {
    notes.push(`Certificate expires in ${tlsResult.daysLeft} days; cert-manager renews it automatically unless the issuer is failing.`);
  }

  // HTTP
  const status = httpResult.status;
  if (status === null) {
    problems.push(`No HTTPS response from ${site.host}: ${httpResult.error}.`);
  } else if (status === 404 && !site.ingress) {
    problems.push('The ingress answered 404: no ingress rule matches this hostname.');
  } else if (status === 502 || status === 503 || status === 504) {
    problems.push(`The ingress returned ${status}: it could not get a response from the app behind it.`);
  } else if (status >= 500) {
    problems.push(`The app returned ${status}: it is running but failing requests.`);
  } else if (status === 401 || status === 403) {
    notes.push('Requires sign-in.');
  } else if (status === 404) {
    notes.push('The app answered 404 on /.');
  }
  if (httpResult.latencyMs !== null && httpResult.latencyMs > 3000 && status !== null) {
    notes.push(`Slow: ${(httpResult.latencyMs / 1000).toFixed(1)}s to answer.`);
  }

  const down =
    status === null ||
    status >= 500 ||
    (status === 404 && !site.ingress) ||
    backends.some((b) => b.kind === 'missing' || (b.kind === 'pods' && b.ready === 0 && b.total > 0) || b.reachable === false) ||
    (tlsResult.error !== null && !tlsResult.subject);
  const degraded = problems.length > 0 || notes.some((n) => n.startsWith('Slow') || n.includes('expires in') || n.includes('pods ready'));

  return {
    host: site.host,
    url,
    name: site.name,
    namespace: site.namespace,
    ingress: site.ingress,
    status: down ? 'down' : degraded ? 'degraded' : 'ok',
    problems,
    notes,
    dns: { addresses: dnsResult.addresses, pointsHere },
    tls: tlsResult,
    certificate: site.certificate,
    http: {
      status,
      latencyMs: httpResult.latencyMs,
      title: pageTitle(httpResult.body),
      finalUrl: httpResult.finalUrl,
      server: typeof httpResult.headers.server === 'string' ? httpResult.headers.server : null,
      error: httpResult.error,
    },
    backends,
    thumbnailAt,
    checkedAt: new Date().toISOString(),
  };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Runs one full check cycle. Concurrent callers share the same run. */
export function checkAll(): Promise<SitesReport> {
  if (running) return running;
  running = (async () => {
    try {
      const { sites, publicIp, error } = await discover();
      const ctx = await buildContext(publicIp);
      const checks = await mapLimit(sites, 6, (s) => checkSite(s, ctx, thumbnailTime(s.host)));
      report = { checkedAt: new Date().toISOString(), publicIp, thumbnails: config.sites.thumbnails, discovery: error, sites: checks };
      return report;
    } catch (err) {
      report = { ...report, checkedAt: new Date().toISOString(), discovery: errorMessage(err) };
      return report;
    } finally {
      running = null;
    }
  })();
  return running;
}

export function getReport(): SitesReport {
  return report;
}

export function startSiteMonitor(): void {
  if (timer) return;
  const tick = async () => {
    try {
      await checkAll();
      if (config.sites.thumbnails) await refreshStaleThumbnails();
    } catch (err) {
      console.error('site check failed', errorMessage(err));
    }
  };
  void tick();
  timer = setInterval(tick, CHECK_INTERVAL_MS);
  timer.unref();
}

// ---------- Thumbnails ----------

export function thumbnailPath(host: string): string {
  return path.join(thumbDir, `${assertHost(host)}.png`);
}

function thumbnailTime(host: string): string | null {
  try {
    return fs.statSync(thumbnailPath(host)).mtime.toISOString();
  } catch {
    return null;
  }
}

let capturing: Promise<void> | null = null;

async function ensureImage(): Promise<void> {
  try {
    await docker.getImage(config.sites.thumbnailImage).inspect();
  } catch {
    console.log(`pulling ${config.sites.thumbnailImage} for site thumbnails`);
    await pullImage(config.sites.thumbnailImage);
  }
}

/** Takes a screenshot of the site with headless Chromium in a throwaway container. One at a time. */
export async function captureThumbnail(host: string): Promise<string> {
  const safeHost = assertHost(host);
  while (capturing) await capturing.catch(() => undefined);
  const job = (async () => {
    await ensureImage();
    const tmpName = `${safeHost}.tmp.png`;
    const finalPath = thumbnailPath(safeHost);
    try {
      fs.unlinkSync(path.join(thumbDir, tmpName));
    } catch {
      // nothing to clean
    }
    const cmd = [
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-software-rasterizer',
      '--hide-scrollbars',
      '--ignore-certificate-errors',
      '--window-size=1280,800',
      '--force-device-scale-factor=1',
      '--virtual-time-budget=6000',
      '--timeout=25000',
      `--screenshot=/out/${tmpName}`,
      `https://${safeHost}/`,
    ];
    let container: Dockerode.Container | null = null;
    const output: Buffer[] = [];
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        if (output.length < 50) output.push(chunk);
        cb();
      },
    });
    await new Promise<void>((resolve, reject) => {
      const killer = setTimeout(() => {
        container?.kill().catch(() => undefined);
        reject(new Error('Screenshot timed out after 45s'));
      }, 45_000);
      const emitter = docker.run(
        config.sites.thumbnailImage,
        cmd,
        sink,
        {
          Entrypoint: [config.sites.thumbnailBin],
          User: '0',
          HostConfig: {
            AutoRemove: true,
            Binds: [`${thumbDir}:/out`],
            Memory: 768 * 1024 * 1024,
            NetworkMode: 'host',
          },
        },
        (err: Error | null, data: { StatusCode: number } | undefined) => {
          clearTimeout(killer);
          if (err) return reject(err);
          if (data && data.StatusCode !== 0) {
            return reject(new Error(`Chromium exited with code ${data.StatusCode}: ${Buffer.concat(output).toString().trim().slice(-300)}`));
          }
          resolve();
        },
      );
      emitter.on('container', (c: Dockerode.Container) => (container = c));
    });
    if (!fs.existsSync(path.join(thumbDir, tmpName))) throw new Error('Chromium produced no screenshot');
    fs.renameSync(path.join(thumbDir, tmpName), finalPath);
    const at = thumbnailTime(safeHost);
    const site = report.sites.find((s) => s.host === safeHost);
    if (site) site.thumbnailAt = at;
    return at ?? new Date().toISOString();
  })();
  capturing = job.then(
    () => undefined,
    () => undefined,
  );
  try {
    return await job;
  } finally {
    capturing = null;
  }
}

async function refreshStaleThumbnails(): Promise<void> {
  const now = Date.now();
  const candidates = report.sites
    .filter((s) => s.http.status !== null)
    .filter((s) => !s.thumbnailAt || now - Date.parse(s.thumbnailAt) > THUMBNAIL_MAX_AGE_MS)
    .sort((a, b) => (a.thumbnailAt ?? '').localeCompare(b.thumbnailAt ?? ''))
    .slice(0, THUMBNAILS_PER_CYCLE);
  for (const site of candidates) {
    try {
      await captureThumbnail(site.host);
    } catch (err) {
      console.error(`thumbnail for ${site.host} failed: ${errorMessage(err)}`);
      // Back off: touch nothing, the next cycle retries the oldest first
      const s = report.sites.find((x) => x.host === site.host);
      if (s) s.notes = [...new Set([...s.notes, `Screenshot failed: ${errorMessage(err).slice(0, 160)}`])];
    }
  }
}
