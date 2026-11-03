import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { errorMessage } from '../utils/http';

/**
 * What the server keeps about a TMS sign-in beyond the session token itself: the TMS access token, so the grant can
 * be re-checked while that token lives, and when it was last checked. Persisted to disk so a restart (every deploy)
 * does not stop the re-checks.
 */
export interface StoredSession {
  sub: string;
  email: string;
  accessToken: string;
  accessExpiresAt: number;
  expiresAt: number;
  checkedAt: number;
}

const file = path.join(config.dataDir, 'sessions.json');
const sessions = new Map<string, StoredSession>();

function load(): void {
  try {
    if (!fs.existsSync(file)) return;
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, StoredSession>;
    const now = Date.now();
    for (const [id, s] of Object.entries(data)) if (s.expiresAt > now) sessions.set(id, s);
  } catch (err) {
    console.warn('Could not read stored sessions:', errorMessage(err));
  }
}

let saveTimer: NodeJS.Timeout | null = null;
function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      fs.mkdirSync(config.dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
    } catch (err) {
      console.warn('Could not store sessions:', errorMessage(err));
    }
  }, 200);
}

load();

export function createSession(s: Omit<StoredSession, 'checkedAt'>): string {
  const id = randomBytes(18).toString('base64url');
  sessions.set(id, { ...s, checkedAt: Date.now() });
  prune();
  save();
  return id;
}

export function getSession(id: string): StoredSession | undefined {
  const s = sessions.get(id);
  if (s && s.expiresAt <= Date.now()) {
    sessions.delete(id);
    return undefined;
  }
  return s;
}

export function touchSession(id: string): void {
  const s = sessions.get(id);
  if (s) {
    s.checkedAt = Date.now();
    save();
  }
}

export function deleteSession(id: string): void {
  if (sessions.delete(id)) save();
}

function prune(): void {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expiresAt <= now) sessions.delete(id);
}
