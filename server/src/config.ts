import dotenv from 'dotenv';
import path from 'path';

const serverRoot = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(serverRoot, '.env') });

function bool(value: string | undefined, fallback = false): boolean {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT) || 4600,
  trustProxy: bool(process.env.TRUST_PROXY),

  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPasswordHash: process.env.ADMIN_PASSWORD_HASH || '',
  jwtSecret: process.env.JWT_SECRET || '',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',

  useSudo: bool(process.env.USE_SUDO),
  protectedServices: list(process.env.PROTECTED_SERVICES ?? 'ssh,sshd,vps-panel'),

  dockerSocket: process.env.DOCKER_SOCKET || '',

  kubectl: process.env.KUBECTL_BIN || 'kubectl',
  ingress: {
    namespace: process.env.INGRESS_NAMESPACE || 'ingress-nginx',
    workload: process.env.INGRESS_WORKLOAD || 'deploy/ingress-nginx-controller',
  },
  protectedNamespaces: list(process.env.PROTECTED_NAMESPACES ?? 'kube-system,ingress-nginx,cert-manager'),

  kafka: {
    brokers: list(process.env.KAFKA_BROKERS),
    clientId: process.env.KAFKA_CLIENT_ID || 'vps-panel',
    ssl: bool(process.env.KAFKA_SSL),
    saslMechanism: (process.env.KAFKA_SASL_MECHANISM || '').toLowerCase(),
    saslUsername: process.env.KAFKA_SASL_USERNAME || '',
    saslPassword: process.env.KAFKA_SASL_PASSWORD || '',
  },

  /**
   * Sign in with TMS: the TMS platform is an OpenID Connect provider and the panel is one of its registered apps
   * (admin portal -> Apps). People sign in on the TMS page; the owner grants access per account with a role
   * (admin portal -> Access). Enabled when the issuer, the client secret and the panel's public URL are set.
   */
  tms: {
    /** How the sign-in is named on the login screens: "Sign in with <name>", "<name> account". */
    name: (process.env.TMS_NAME || 'HW').trim(),
    /** e.g. https://admin.helloworlds.co.in/platform/oidc (discovery is read from <issuer>/.well-known/openid-configuration) */
    issuer: (process.env.TMS_ISSUER || '').trim().replace(/\/+$/, ''),
    clientId: (process.env.TMS_CLIENT_ID || 'vps-panel').trim(),
    clientSecret: (process.env.TMS_CLIENT_SECRET || '').trim(),
    scopes: (process.env.TMS_SCOPES || 'openid email profile roles').trim(),
    /** Roles (from the id token) that may change things; everyone else signed in through TMS is read-only. */
    adminRoles: list(process.env.TMS_ADMIN_ROLES ?? 'owner,admin'),
    /** How long the panel's own session lasts after a TMS sign-in. */
    sessionHours: Number(process.env.TMS_SESSION_HOURS) || 8,
    /** Also end the TMS single sign-on (its 8-hour cookie) when signing out of the panel. */
    logoutEverywhere: bool(process.env.TMS_LOGOUT_EVERYWHERE, true),
  },
  /** The address people open the panel at, e.g. https://panel.example.com; the sign-in redirect is <PUBLIC_URL>/auth/callback. */
  publicUrl: (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, ''),
  /** The panel's own admin username/password login. Keep it as the break-glass path when TMS itself is down. */
  passwordLogin: bool(process.env.PASSWORD_LOGIN, true),

  sites: {
    /** Extra hostnames to monitor that have no ingress in the cluster. */
    extra: list(process.env.SITES),
    /** The server's public IP; detected from the ingress controller when empty. */
    publicIp: process.env.PUBLIC_IP || '',
    thumbnails: bool(process.env.THUMBNAILS, true),
    thumbnailImage: process.env.THUMBNAIL_IMAGE || 'zenika/alpine-chrome:latest',
    thumbnailBin: process.env.THUMBNAIL_BIN || 'chromium-browser',
  },

  dataDir: process.env.DATA_DIR || path.join(serverRoot, 'data'),
  clientDist: path.resolve(serverRoot, '../client/dist'),
};

/** Refuse to boot with missing or weak credentials: this panel controls the whole machine. */
export function assertConfig(): void {
  const problems: string[] = [];
  if (!config.adminPasswordHash) problems.push('ADMIN_PASSWORD_HASH is not set');
  if (config.jwtSecret.length < 32) problems.push('JWT_SECRET must be at least 32 characters');
  if (problems.length) {
    console.error('Invalid configuration:\n' + problems.map((p) => `  - ${p}`).join('\n'));
    console.error('\nRun `npm run setup -- --username admin --password <password>` to create server/.env');
    process.exit(1);
  }
}
