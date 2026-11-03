import type * as OIDC from 'openid-client';
import { config } from '../config';
import { errorMessage, HttpError } from '../utils/http';

/**
 * Sign in with TMS: the TMS platform is an OpenID Connect provider (issuer <ADMIN_URL>/platform/oidc) and the
 * panel is one of its registered apps. This module is the relying-party side — discovery, the authorization-code
 * flow with PKCE, token verification and the userinfo re-check — done by openid-client; nothing token-shaped is
 * hand-rolled here.
 */

export interface TmsIdentity {
  /** The TMS user id: permanent, even when the email changes. */
  sub: string;
  email: string;
  name: string;
  /** The role the owner picked for this person in the panel app, or "owner" for the TMS owners. */
  role: string | null;
  /** When the person last typed their password (id token auth_time). */
  signedInAt: Date;
  /** The TMS access token and when it stops working (used to re-check the grant while it lives). */
  accessToken: string;
  accessExpiresAt: Date;
}

export interface PendingLogin {
  codeVerifier: string;
  state: string;
  nonce: string;
}

export function isEnabled(): boolean {
  return Boolean(config.tms.issuer && config.tms.clientSecret && config.publicUrl);
}

export function redirectUri(): string {
  return `${config.publicUrl}/auth/callback`;
}

// openid-client v6 is ESM-only and this server is compiled to CommonJS: load it once through a real dynamic import
// (tsc would otherwise rewrite import() into require(), which older Node versions refuse for ES modules).
const loadModule = new Function('return import("openid-client")') as () => Promise<typeof OIDC>;
let modulePromise: Promise<typeof OIDC> | null = null;
function oidc(): Promise<typeof OIDC> {
  modulePromise ??= loadModule();
  return modulePromise;
}

const RETRY_MS = 15_000;
let configuration: OIDC.Configuration | null = null;
let discovering: Promise<OIDC.Configuration> | null = null;
let lastFailure = 0;

/**
 * The provider's endpoints and keys, read from the discovery document the first time they are needed and kept.
 * A failure (the provider not deployed yet, TMS down) is retried on the next sign-in, at most every 15 seconds.
 */
export async function client(): Promise<OIDC.Configuration> {
  if (configuration) return configuration;
  if (!isEnabled()) throw new HttpError(404, `Sign in with ${config.tms.name} is not enabled on this panel`);
  if (Date.now() - lastFailure < RETRY_MS) throw new HttpError(503, `${config.tms.name} sign-in is not reachable right now; try again in a moment`, 'TMS_UNAVAILABLE');
  discovering ??= (async () => {
    const lib = await oidc();
    const issuer = new URL(config.tms.issuer);
    try {
      const c = await lib.discovery(
        issuer,
        config.tms.clientId,
        config.tms.clientSecret,
        lib.ClientSecretPost(config.tms.clientSecret),
        issuer.protocol === 'http:' ? { execute: [lib.allowInsecureRequests] } : undefined,
      );
      configuration = c;
      return c;
    } catch (err) {
      lastFailure = Date.now();
      throw new HttpError(503, `${config.tms.name} sign-in is not available: ${errorMessage(err)}`, 'TMS_UNAVAILABLE');
    } finally {
      discovering = null;
    }
  })();
  return discovering;
}

/** Reads the discovery document early so the first sign-in does not wait for it; failures are only logged. */
export function warmUp(): void {
  if (!isEnabled()) return;
  client()
    .then((c) => console.log(`Sign in with TMS: ${c.serverMetadata().issuer} (client ${config.tms.clientId})`))
    .catch((err) => console.warn(`Sign in with TMS: ${errorMessage(err)} (will retry at the next sign-in)`));
}

/** Step 1: where to send the browser, plus what to remember until it comes back. */
export async function startLogin(): Promise<{ url: string; pending: PendingLogin }> {
  const lib = await oidc();
  const c = await client();
  const codeVerifier = lib.randomPKCECodeVerifier();
  const state = lib.randomState();
  const nonce = lib.randomNonce();
  const url = lib.buildAuthorizationUrl(c, {
    redirect_uri: redirectUri(),
    scope: config.tms.scopes,
    code_challenge: await lib.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return { url: url.href, pending: { codeVerifier, state, nonce } };
}

/** Step 2: the browser is back with ?code&state. Exchange it, verify the id token and read who this is. */
export async function finishLogin(callbackUrl: URL, pending: PendingLogin): Promise<TmsIdentity> {
  const lib = await oidc();
  const c = await client();
  let tokens: Awaited<ReturnType<typeof lib.authorizationCodeGrant>>;
  try {
    tokens = await lib.authorizationCodeGrant(c, callbackUrl, {
      pkceCodeVerifier: pending.codeVerifier,
      expectedState: pending.state,
      expectedNonce: pending.nonce,
    });
  } catch (err) {
    throw translate(err, `Sign-in with ${config.tms.name} failed`);
  }
  const claims = tokens.claims();
  if (!claims) throw new HttpError(502, `${config.tms.name} answered without an id token`);
  const expiresIn = tokens.expiresIn() ?? 3600;
  const role = typeof claims.role === 'string' ? claims.role : null;
  return {
    sub: claims.sub,
    email: typeof claims.email === 'string' ? claims.email : '',
    name: typeof claims.name === 'string' && claims.name ? claims.name : (typeof claims.email === 'string' ? claims.email : claims.sub),
    role,
    signedInAt: new Date((typeof claims.auth_time === 'number' ? claims.auth_time : claims.iat ?? Date.now() / 1000) * 1000),
    accessToken: tokens.access_token,
    accessExpiresAt: new Date(Date.now() + expiresIn * 1000),
  };
}

export type Recheck = { ok: true } | { ok: false; status: 401 | 403; message: string };

/**
 * Asks the TMS whether this access token still stands for an account that may use the panel. The TMS re-checks the
 * grant on every userinfo call, so a removed grant answers 403 while the token lives (one hour).
 */
export async function recheck(sub: string, accessToken: string): Promise<Recheck> {
  const lib = await oidc();
  const c = await client();
  try {
    await lib.fetchUserInfo(c, accessToken, sub);
    return { ok: true };
  } catch (err) {
    const e = translate(err, `${config.tms.name} refused the session`);
    if (e.status === 401 || e.status === 403) return { ok: false, status: e.status, message: e.message };
    throw e;
  }
}

/** Where to send the browser after signing out so the TMS single sign-on cookie ends too. */
export async function logoutUrl(): Promise<string | null> {
  if (!isEnabled() || !config.tms.logoutEverywhere) return null;
  try {
    const lib = await oidc();
    const c = await client();
    if (!c.serverMetadata().end_session_endpoint) return null;
    return lib.buildEndSessionUrl(c, { post_logout_redirect_uri: `${config.publicUrl}/` }).href;
  } catch {
    return null;
  }
}

/** Turns openid-client's errors into the panel's: no grant -> 403, a bad or re-used code -> 401, the rest -> 502. */
function translate(err: unknown, fallback: string): HttpError {
  if (err instanceof HttpError) return err;
  const e = err as { error?: string; error_description?: string; status?: number; message?: string; name?: string; cause?: unknown };
  const code = e.error ?? '';
  const detail = e.error_description ?? e.message ?? fallback;
  // A plain 403 from userinfo (no OAuth error body) surfaces as a ClientError whose cause is the Response
  const cause = e.cause as { status?: unknown } | undefined;
  const status = e.status ?? (cause && typeof cause.status === 'number' ? cause.status : undefined);
  if (code === 'access_denied' || status === 403) {
    return new HttpError(403, `Your account has no access to the VPS panel. An owner can grant it in the ${config.tms.name} admin portal (Access).`, 'NO_ACCESS');
  }
  if (code === 'invalid_grant' || status === 401 || e.name === 'AuthorizationResponseError') {
    return new HttpError(401, `${fallback}: ${detail}`, 'UNAUTHENTICATED');
  }
  if (code === 'invalid_client') return new HttpError(502, `${config.tms.name} does not accept this panel's client id or secret: ${detail}`);
  return new HttpError(502, `${fallback}: ${detail}`);
}
