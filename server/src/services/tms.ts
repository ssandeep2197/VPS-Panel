import { createHash } from 'crypto';
import http from 'http';
import https from 'https';
import { config } from '../config';
import { errorMessage, HttpError } from '../utils/http';
import { docker } from './docker';

/**
 * The panel as a TMS single-sign-on site. TMS issues a per-host cookie (tms_sso) after a sign-in with a TMS
 * account; this module asks the TMS API whether a cookie is valid for the "panel" service (and whether the
 * account still has the grant) and proxies the API's sign-in pages so they appear on the panel's own hostname.
 */

export const SSO_COOKIE = 'tms_sso';
const CHECK_CACHE_MS = 30_000;
const FAIL_CACHE_MS = 5_000;
const DISCOVERY_MS = 60_000;
const TIMEOUT_MS = 10_000;

export function isEnabled(): boolean {
  return config.tms.sso && config.tms.host.length > 0;
}

// ---------- Finding the API ----------

let discovered: { url: string; at: number } | null = null;

/** Base URL of the TMS API: configured, or the compose container's address on its Docker network. */
export async function apiBase(force = false): Promise<string> {
  if (config.tms.apiUrl) return config.tms.apiUrl;
  if (!force && discovered && Date.now() - discovered.at < DISCOVERY_MS) return discovered.url;
  let containers: Awaited<ReturnType<typeof docker.listContainers>>;
  try {
    containers = await docker.listContainers({
      filters: {
        status: ['running'],
        label: [
          `com.docker.compose.project=${config.tms.composeProject}`,
          `com.docker.compose.service=${config.tms.composeService}`,
        ],
      },
    });
  } catch (err) {
    throw new HttpError(503, `Cannot look up the TMS API container: ${errorMessage(err)}`, 'TMS_UNAVAILABLE');
  }
  for (const c of containers) {
    const ip = Object.values(c.NetworkSettings?.Networks ?? {})
      .map((n) => n.IPAddress)
      .find((a) => a);
    if (ip) {
      discovered = { url: `http://${ip}:${config.tms.apiPort}`, at: Date.now() };
      return discovered.url;
    }
  }
  throw new HttpError(
    503,
    `No running "${config.tms.composeService}" container of compose project "${config.tms.composeProject}"; set TMS_API_URL`,
    'TMS_UNAVAILABLE',
  );
}

// ---------- Low level request ----------

export interface TmsResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function send(base: string, method: string, path: string, headers: Record<string, string>, body?: Buffer): Promise<TmsResponse> {
  return new Promise((resolve, reject) => {
    const target = new URL(base + path);
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(
      target,
      {
        method,
        timeout: TIMEOUT_MS,
        headers: {
          ...headers,
          // The API decides which gated service this is from the host name (SSO_SERVICE_HOSTS)
          host: config.tms.host,
          'x-forwarded-host': config.tms.host,
          'x-forwarded-proto': 'https',
          ...(body ? { 'content-length': String(body.length) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('TMS API did not answer in time')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Sends to the API, re-discovering the container once if the cached address no longer answers. */
export async function request(method: string, path: string, headers: Record<string, string> = {}, body?: Buffer): Promise<TmsResponse> {
  try {
    return await send(await apiBase(), method, path, headers, body);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!config.tms.apiUrl && discovered && code && ['ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT'].includes(code)) {
      return send(await apiBase(true), method, path, headers, body);
    }
    throw err;
  }
}

// ---------- Session check ----------

export type SessionCheck = { ok: true; email: string } | { ok: false; status: 401 | 403; message: string };

const checks = new Map<string, { at: number; result: SessionCheck }>();

/** Whether a tms_sso cookie proves a signed-in account that may use the panel. Answers are cached briefly. */
export async function checkSession(cookie: string): Promise<SessionCheck> {
  const key = createHash('sha256').update(cookie).digest('hex');
  const hit = checks.get(key);
  if (hit && Date.now() - hit.at < (hit.result.ok ? CHECK_CACHE_MS : FAIL_CACHE_MS)) return hit.result;
  let result: SessionCheck;
  try {
    const res = await request('GET', '/platform/sso/check', { cookie: `${SSO_COOKIE}=${cookie}`, accept: 'application/json' });
    if (res.status === 200) {
      const data = JSON.parse(res.body.toString()) as { data?: { email?: string } };
      const email = data.data?.email;
      result = email ? { ok: true, email } : { ok: false, status: 401, message: 'TMS answered without an account' };
    } else {
      result = { ok: false, status: res.status === 403 ? 403 : 401, message: apiMessage(res) };
    }
  } catch (err) {
    throw new HttpError(503, `TMS is not reachable: ${errorMessage(err)}`, 'TMS_UNAVAILABLE');
  }
  checks.set(key, { at: Date.now(), result });
  if (checks.size > 500) checks.delete(checks.keys().next().value as string);
  return result;
}

/** The API's own error text when it sent JSON; otherwise something sensible for the status. */
export function apiMessage(res: TmsResponse): string {
  const type = String(res.headers['content-type'] ?? '');
  if (type.includes('json')) {
    try {
      const data = JSON.parse(res.body.toString()) as { error?: { message?: string }; message?: string };
      const text = data.error?.message ?? data.message;
      if (text) return text;
    } catch {
      // fall through
    }
  }
  if (res.status === 401) return 'Invalid email or password';
  if (res.status === 403) return 'Your account has no access to the VPS panel. An owner can grant it in the TMS admin portal (Access).';
  if (res.status === 429) return 'Too many sign-in attempts. Try again in 15 minutes.';
  return `TMS answered ${res.status}`;
}

/** Pulls the tms_sso value out of a Set-Cookie header list. */
export function sessionCookieFrom(setCookie: string | string[] | undefined): string | null {
  for (const line of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
    const m = new RegExp(`^${SSO_COOKIE}=([^;]*)`).exec(line);
    if (m) return m[1];
  }
  return null;
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
