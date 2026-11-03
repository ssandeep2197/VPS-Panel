import express, { Router } from 'express';
import { auditEvent } from '../audit';
import { config } from '../config';
import { apiMessage, checkSession, isEnabled, request, sessionCookieFrom, SSO_COOKIE } from '../services/tms';
import { asyncHandler, HttpError } from '../utils/http';

/**
 * /platform/sso/* on the panel's own hostname, passed through to the TMS API exactly like the nginx of TMS's other
 * gated hosts does: the sign-in page (GET/POST login), the admin portal's hand-over (consume), check and logout.
 * Mounted before the JSON body parser so the HTML form's body is forwarded untouched.
 */
export const ssoRouter = Router();

const ALLOWED = new Set(['/login', '/consume', '/check', '/logout']);
const FORWARD_REQUEST = ['content-type', 'accept', 'accept-language', 'cookie', 'user-agent', 'referer'];
const FORWARD_RESPONSE = ['content-type', 'set-cookie', 'location', 'cache-control', 'www-authenticate', 'retry-after'];

ssoRouter.use((req, _res, next) => {
  if (!isEnabled()) return next(new HttpError(404, 'Sign-in with TMS is not enabled on this panel'));
  if (!ALLOWED.has(req.path)) return next(new HttpError(404, 'Not found'));
  next();
});

ssoRouter.use(express.raw({ type: () => true, limit: '64kb' }));

function forwardHeaders(req: express.Request): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARD_REQUEST) {
    const value = req.headers[name];
    if (typeof value === 'string') headers[name] = value;
  }
  headers['x-forwarded-for'] = req.ip ?? '';
  return headers;
}

/** JSON sign-in for the panel's own login screens (web and iPhone): same check as the HTML form, JSON answer. */
async function jsonLogin(req: express.Request, res: express.Response): Promise<void> {
  let input: { email?: unknown; password?: unknown };
  try {
    input = JSON.parse((req.body as Buffer).toString()) as typeof input;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
  const email = typeof input.email === 'string' ? input.email.trim() : '';
  const password = typeof input.password === 'string' ? input.password : '';
  if (!email || !password) throw new HttpError(400, 'Email and password are required');
  const form = new URLSearchParams({ email, password, to: '/' }).toString();
  const upstream = await request(
    'POST',
    '/platform/sso/login',
    { ...forwardHeaders(req), 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' },
    Buffer.from(form),
  );
  const cookie = sessionCookieFrom(upstream.headers['set-cookie']);
  if (upstream.status === 303 && cookie) {
    const session = await checkSession(cookie);
    if (!session.ok) throw new HttpError(session.status, session.message, 'NO_ACCESS');
    for (const line of upstream.headers['set-cookie'] ?? []) res.append('Set-Cookie', line);
    auditEvent(session.email, req.ip ?? '', 'auth.login', session.email, true, 'tms');
    res.json({ username: session.email, cookie, expiresIn: 8 * 3600 });
    return;
  }
  const message = apiMessage(upstream);
  auditEvent(email, req.ip ?? '', 'auth.login', email, false, `tms: ${message}`);
  const status = upstream.status === 401 || upstream.status === 403 || upstream.status === 429 ? upstream.status : 502;
  throw new HttpError(status, message, status === 401 ? 'BAD_CREDENTIALS' : status === 403 ? 'NO_ACCESS' : undefined);
}

ssoRouter.all(
  '*',
  asyncHandler(async (req, res) => {
    const wantsJson = req.method === 'POST' && req.path === '/login' && (req.is('application/json') || req.accepts(['html', 'json']) === 'json');
    if (wantsJson) return jsonLogin(req, res);

    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const body = Buffer.isBuffer(req.body) && req.body.length ? req.body : undefined;
    const upstream = await request(req.method, `/platform/sso${req.path}${query}`, forwardHeaders(req), body);

    if (req.path === '/consume' && upstream.status === 302) {
      const cookie = sessionCookieFrom(upstream.headers['set-cookie']);
      const session = cookie ? await checkSession(cookie).catch(() => null) : null;
      auditEvent(session?.ok ? session.email : 'unknown', req.ip ?? '', 'auth.login', session?.ok ? session.email : '', true, 'tms ticket');
    }
    res.status(upstream.status);
    for (const name of FORWARD_RESPONSE) {
      const value = upstream.headers[name];
      if (value !== undefined) res.setHeader(name, value);
    }
    res.send(upstream.body);
  }),
);

/** Cookie options matching what the TMS API set, so clearing it on the panel host works. */
export function clearSessionCookie(req: express.Request, res: express.Response): void {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  res.clearCookie(SSO_COOKIE, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
  void config;
}
