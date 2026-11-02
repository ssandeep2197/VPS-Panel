import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { Router, type RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { z } from 'zod';
import { audit } from './audit';
import { config } from './config';
import { asyncHandler, HttpError } from './utils/http';

export interface AuthUser {
  username: string;
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
    return { username: payload.sub };
  } catch {
    throw new HttpError(401, 'Invalid or expired session', 'UNAUTHENTICATED');
  }
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) {
    next(new HttpError(401, 'Authentication required', 'UNAUTHENTICATED'));
    return;
  }
  try {
    req.user = verifyToken(header.slice(7));
    next();
  } catch (err) {
    next(err);
  }
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
    req.user = { username };
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
