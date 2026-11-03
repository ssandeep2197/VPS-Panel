import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import { audit } from './audit';
import { config } from './config';
import { clearSessionCookie } from './routes/sso';
import { checkSession, isEnabled as tmsEnabled, parseCookies, SSO_COOKIE } from './services/tms';
import { asyncHandler, HttpError } from './utils/http';

export interface AuthUser {
  username: string;
  /** token = the panel's own admin login; tms = a TMS account signed in through single sign-on. */
  via: 'token' | 'tms';
}

declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
  }
}

export function verifyToken(token: string): AuthUser {
  try {
    const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
    if (typeof payload === 'string' || typeof payload.sub !== 'string') throw new Error('bad payload');
    return { username: payload.sub, via: 'token' };
  } catch {
    throw new HttpError(401, 'Invalid or expired session', 'UNAUTHENTICATED');
  }
}

/**
 * Who is calling: the panel's own bearer token, or (with TMS sign-in on) the tms_sso cookie that the TMS API
 * confirms is a signed-in account with access to the panel.
 */
export async function authenticate(authorization: string | undefined, cookieHeader: string | undefined): Promise<AuthUser> {
  const header = authorization ?? '';
  if (header.startsWith('Bearer ') && header.length > 7) return verifyToken(header.slice(7));
  if (tmsEnabled()) {
    const cookie = parseCookies(cookieHeader)[SSO_COOKIE];
    if (cookie) {
      const session = await checkSession(cookie);
      if (session.ok) return { username: session.email, via: 'tms' };
      throw new HttpError(session.status, session.message, session.status === 403 ? 'NO_ACCESS' : 'UNAUTHENTICATED');
    }
  }
  throw new HttpError(401, 'Authentication required', 'UNAUTHENTICATED');
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  authenticate(req.headers.authorization, req.headers.cookie)
    .then((user) => {
      req.user = user;
      next();
    })
    .catch(next);
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
    const { username, password } = loginSchema.parse(req.body);
    const userOk = safeEqual(username, config.adminUsername);
    const passOk = await bcrypt.compare(password, config.adminPasswordHash);
    if (!userOk || !passOk) {
      audit(req, 'auth.login', username, false, 'invalid credentials');
      throw new HttpError(401, 'Invalid username or password', 'BAD_CREDENTIALS');
    }
    req.user = { username, via: 'token' };
    audit(req, 'auth.login', username, true);
    const token = jwt.sign({}, config.jwtSecret, {
      subject: username,
      algorithm: 'HS256',
      expiresIn: config.jwtExpiresIn as SignOptions['expiresIn'],
    });
    res.json({ token, username });
  }),
);

authRouter.get('/me', requireAuth, (req, res) => {
  res.json(req.user);
});

/** Which sign-in methods this panel offers, for the login screens. */
authRouter.get('/mode', (_req, res) => {
  res.json({ tms: tmsEnabled(), host: tmsEnabled() ? config.tms.host : null, legacy: true });
});

authRouter.post('/logout', requireAuth, (req, res) => {
  audit(req, 'auth.logout', req.user?.username ?? '', true);
  clearSessionCookie(req, res);
  res.json({ ok: true });
});
