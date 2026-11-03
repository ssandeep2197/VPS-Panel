import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { auditEvent } from '../audit';
import { clearSessionCookie, cookieOptions, issueToken, setSessionCookie } from '../auth';
import { config } from '../config';
import { createSession } from '../services/sessions';
import { finishLogin, isEnabled, logoutUrl, startLogin, type PendingLogin } from '../services/tms';
import { asyncHandler, errorMessage, HttpError } from '../utils/http';

/**
 * /auth/* — the browser side of Sign in with TMS.
 *   GET /auth/login?to=/path          start: remember PKCE/state/nonce in a 10-minute cookie, go to the TMS
 *   GET /auth/login?client=ios        same, but the result is handed to the iPhone app (vpspanel://signed-in)
 *   GET /auth/callback?code&state     finish: exchange the code, create the panel session, continue
 *   GET /auth/logout                  end the panel session, then the TMS single sign-on
 */
export const oidcRouter = Router();

const PENDING_COOKIE = 'vps_panel_login';
const PENDING_SECONDS = 600;
/** The iPhone app's own URL scheme; the sign-in result is handed back through it. */
export const IOS_CALLBACK = 'vpspanel://signed-in';

interface PendingClaims extends PendingLogin {
  client: 'web' | 'ios';
  to: string;
}

function safePath(to: unknown): string {
  return typeof to === 'string' && to.startsWith('/') && !to.startsWith('//') ? to.slice(0, 500) : '/';
}

oidcRouter.use((_req, _res, next) => {
  if (!isEnabled()) return next(new HttpError(404, 'Sign in with TMS is not enabled on this panel'));
  next();
});

oidcRouter.get(
  '/login',
  asyncHandler(async (req, res) => {
    const client = req.query.client === 'ios' ? 'ios' : 'web';
    const { url, pending } = await startLogin();
    const claims: PendingClaims = { ...pending, client, to: safePath(req.query.to) };
    const cookie = jwt.sign(claims, config.jwtSecret, { algorithm: 'HS256', expiresIn: PENDING_SECONDS });
    res.cookie(PENDING_COOKIE, cookie, { ...cookieOptions(req), maxAge: PENDING_SECONDS * 1000 });
    res.setHeader('Cache-Control', 'no-store');
    res.redirect(302, url);
  }),
);

oidcRouter.get(
  '/callback',
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const raw = (req.headers.cookie ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${PENDING_COOKIE}=`));
    res.clearCookie(PENDING_COOKIE, cookieOptions(req));
    let pending: PendingClaims | null = null;
    try {
      if (raw) pending = jwt.verify(decodeURIComponent(raw.slice(PENDING_COOKIE.length + 1)), config.jwtSecret, { algorithms: ['HS256'] }) as PendingClaims;
    } catch {
      pending = null;
    }
    const fail = (status: number, message: string, client: 'web' | 'ios') => {
      auditEvent('unknown', req.ip ?? '', 'auth.login', '', false, `tms: ${message}`);
      if (client === 'ios') return res.redirect(302, `${IOS_CALLBACK}?error=${encodeURIComponent(message)}`);
      // The web app shows the message on its login screen
      res.redirect(302, `/login?error=${encodeURIComponent(message)}`);
      void status;
    };
    if (!pending) return fail(400, 'The sign-in took too long or was started elsewhere; try again', 'web');

    let identity;
    try {
      identity = await finishLogin(new URL(req.originalUrl, config.publicUrl), pending);
    } catch (err) {
      return fail(err instanceof HttpError ? err.status : 502, errorMessage(err), pending.client);
    }
    const hours = config.tms.sessionHours;
    const expiresAt = Date.now() + hours * 3600 * 1000;
    const sid = createSession({
      sub: identity.sub,
      email: identity.email,
      accessToken: identity.accessToken,
      accessExpiresAt: identity.accessExpiresAt.getTime(),
      expiresAt,
    });
    const token = issueToken(
      { username: identity.email || identity.sub, via: 'tms', sub: identity.sub, name: identity.name, role: identity.role, sid },
      `${hours}h`,
    );
    auditEvent(identity.email, req.ip ?? '', 'auth.login', identity.email, true, `tms (${identity.role ?? 'no role'}, ${pending.client})`);
    if (pending.client === 'ios') {
      res.redirect(302, `${IOS_CALLBACK}?token=${encodeURIComponent(token)}`);
      return;
    }
    setSessionCookie(req, res, token, hours * 3600 * 1000);
    res.redirect(302, pending.to);
  }),
);

oidcRouter.get(
  '/logout',
  asyncHandler(async (req, res) => {
    clearSessionCookie(req, res);
    res.redirect(302, (await logoutUrl()) ?? '/');
  }),
);
