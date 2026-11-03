import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import { audit } from './audit';
import { config } from './config';
import { deleteSession, getSession, touchSession } from './services/sessions';
import { isEnabled as tmsEnabled, logoutUrl, recheck } from './services/tms';
import { asyncHandler, HttpError } from './utils/http';

export interface AuthUser {
  /** The display name of the account: the admin username, or the TMS account's email. */
  username: string;
  /** token = the panel's own admin login; tms = a TMS account signed in with Sign in with TMS. */
  via: 'token' | 'tms';
  /** TMS user id (permanent) and profile; absent for the panel's own admin login. */
  sub?: string;
  name?: string;
  role?: string | null;
  /** The server-side session record (TMS sign-ins only). */
  sid?: string;
  /** When the session ends. */
  expiresAt: Date;
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export const SESSION_COOKIE = 'vps_panel_session';
const RECHECK_MS = 60_000;

/** May this account change things? The panel's own admin always; TMS accounts by their role (TMS_ADMIN_ROLES). */
export function canWrite(user: AuthUser): boolean {
  if (user.via === 'token') return true;
  return Boolean(user.role && config.tms.adminRoles.includes(user.role));
}

/** The panel's own session token: HS256 with JWT_SECRET, for both sign-in methods. */
export function issueToken(user: Omit<AuthUser, 'expiresAt'>, expiresIn: string | number): string {
  const claims: Record<string, unknown> = { via: user.via, name: user.username };
  if (user.via === 'tms') Object.assign(claims, { tms: user.sub, full: user.name, role: user.role, sid: user.sid });
  return jwt.sign(claims, config.jwtSecret, {
    subject: user.username,
    algorithm: 'HS256',
    expiresIn: expiresIn as SignOptions['expiresIn'],
  });
}

export function verifyToken(token: string): AuthUser {
  let payload: jwt.JwtPayload & { sub: string };
  try {
    const p = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof p === 'string' || typeof p.sub !== 'string') throw new Error('bad payload');
    payload = p as jwt.JwtPayload & { sub: string };
  } catch {
    throw new HttpError(401, 'Invalid or expired session', 'UNAUTHENTICATED');
  }
  const expiresAt = new Date((payload.exp ?? 0) * 1000);
  if (payload.via === 'tms') {
    return {
      username: payload.sub,
      via: 'tms',
      sub: typeof payload.tms === 'string' ? payload.tms : undefined,
      name: typeof payload.full === 'string' ? payload.full : payload.sub,
      role: typeof payload.role === 'string' ? payload.role : null,
      sid: typeof payload.sid === 'string' ? payload.sid : undefined,
      expiresAt,
    };
  }
  return { username: payload.sub, via: 'token', expiresAt };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * Who is calling: the bearer token (the iPhone app, or the web app after a password login) or the session cookie
 * (the web app after a TMS sign-in). A TMS session is re-checked with the TMS about once a minute while its access
 * token lives, so a grant removed in the admin portal ends the session.
 */
export async function authenticate(authorization: string | undefined, cookieHeader: string | undefined): Promise<AuthUser> {
  const header = authorization ?? '';
  let token: string | undefined;
  if (header.startsWith('Bearer ') && header.length > 7) token = header.slice(7);
  else token = parseCookies(cookieHeader)[SESSION_COOKIE];
  if (!token) throw new HttpError(401, 'Authentication required', 'UNAUTHENTICATED');
  const user = verifyToken(token);
  if (user.via === 'tms' && user.sid && user.sub && tmsEnabled()) {
    const stored = getSession(user.sid);
    if (!stored) throw new HttpError(401, 'Your session has ended; sign in again', 'UNAUTHENTICATED');
    const now = Date.now();
    if (stored.accessExpiresAt > now && now - stored.checkedAt > RECHECK_MS) {
      const result = await recheck(user.sub, stored.accessToken).catch(() => ({ ok: true }) as const);
      if (!result.ok && result.status === 403) {
        // The grant was removed in the admin portal: the session ends now
        deleteSession(user.sid);
        throw new HttpError(403, result.message, 'NO_ACCESS');
      }
      // 401 = the TMS no longer recognises the access token (expired early, keys rotated): the panel's own session
      // stands until it expires, there is just nothing left to re-check it against
      if (!result.ok) stored.accessExpiresAt = now;
      touchSession(user.sid);
    }
  }
  return user;
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  authenticate(req.headers.authorization, req.headers.cookie)
    .then((user) => {
      req.user = user;
      // A cookie session on a state-changing request must come from the panel's own page, not a third-party form
      if (req.method !== 'GET' && req.method !== 'HEAD' && !req.headers.authorization && req.headers['x-requested-with'] !== 'vps-panel') {
        throw new HttpError(403, 'Cross-site request refused', 'CSRF');
      }
      next();
    })
    .catch(next);
};

/** Read-only accounts (a TMS "viewer") may only GET, plus a few harmless refresh actions. */
const READ_ONLY_ALLOWED = [/^\/sites\/refresh$/, /^\/sites\/[^/]+\/thumbnail$/];
export const requireWrite: RequestHandler = (req, _res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
  if (req.user && canWrite(req.user)) return next();
  if (READ_ONLY_ALLOWED.some((re) => re.test(req.path))) return next();
  next(new HttpError(403, `Your panel role (${req.user?.role ?? 'none'}) is read-only; an owner can change it in the ${config.tms.name} admin portal (Access)`, 'READ_ONLY'));
};

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const loginSchema = z.object({
  username: z.string().min(1).max(100),
  password: z.string().min(1).max(200),
});

export function cookieOptions(req: Request) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https' || config.publicUrl.startsWith('https://');
  return { httpOnly: true, secure, sameSite: 'lax' as const, path: '/' };
}

export function setSessionCookie(req: Request, res: Response, token: string, maxAgeMs: number): void {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(req), maxAge: maxAgeMs });
}

export function clearSessionCookie(req: Request, res: Response): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions(req));
}

export function publicUser(user: AuthUser) {
  return {
    username: user.username,
    via: user.via,
    sub: user.sub ?? null,
    name: user.name ?? user.username,
    role: user.via === 'token' ? 'admin' : (user.role ?? null),
    canWrite: canWrite(user),
    expiresAt: user.expiresAt.toISOString(),
  };
}

export const authRouter = Router();

authRouter.post(
  '/login',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts. Try again in 15 minutes.' },
  }),
  asyncHandler(async (req, res) => {
    if (!config.passwordLogin) throw new HttpError(404, `The panel password login is turned off; sign in with ${config.tms.name}`, 'PASSWORD_LOGIN_OFF');
    const { username, password } = loginSchema.parse(req.body);
    const userOk = safeEqual(username, config.adminUsername);
    const passOk = await bcrypt.compare(password, config.adminPasswordHash);
    if (!userOk || !passOk) {
      audit(req, 'auth.login', username, false, 'invalid credentials');
      throw new HttpError(401, 'Invalid username or password', 'BAD_CREDENTIALS');
    }
    req.user = { username, via: 'token', expiresAt: new Date() };
    audit(req, 'auth.login', username, true, 'password');
    const token = issueToken({ username, via: 'token' }, config.jwtExpiresIn);
    res.json({ token, username });
  }),
);

authRouter.get('/me', requireAuth, (req, res) => {
  res.json(publicUser(req.user!));
});

/** Which sign-in methods this panel offers, for the login screens. */
authRouter.get('/mode', (_req, res) => {
  res.json({
    tms: tmsEnabled(),
    name: config.tms.name,
    legacy: config.passwordLogin,
    issuer: tmsEnabled() ? config.tms.issuer : null,
    loginUrl: tmsEnabled() ? '/auth/login' : null,
  });
});

/** Ends the panel session; the answer carries where to send the browser to end the TMS single sign-on too. */
authRouter.post(
  '/logout',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = req.user!;
    audit(req, 'auth.logout', user.username, true);
    if (user.sid) deleteSession(user.sid);
    clearSessionCookie(req, res);
    res.json({ ok: true, logoutUrl: user.via === 'tms' ? await logoutUrl() : null });
  }),
);
