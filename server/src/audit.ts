import type { Request } from 'express';
import fs from 'fs';
import path from 'path';
import { config } from './config';
import { errorMessage } from './utils/http';

export interface AuditEntry {
  ts: string;
  user: string;
  ip: string;
  action: string;
  target: string;
  ok: boolean;
  detail?: string;
}

const MAX_BYTES = 5 * 1024 * 1024;
const file = path.join(config.dataDir, 'audit.log');

fs.mkdirSync(config.dataDir, { recursive: true });

export function audit(req: Request, action: string, target: string, ok: boolean, detail?: string): void {
  auditEvent(req.user?.username ?? 'anonymous', req.ip ?? '', action, target, ok, detail);
}

/** Records an event that did not come through an Express request (e.g. a WebSocket session). */
export function auditEvent(
  user: string,
  ip: string,
  action: string,
  target: string,
  ok: boolean,
  detail?: string,
): void {
  const entry: AuditEntry = { ts: new Date().toISOString(), user, ip, action, target, ok, detail };
  try {
    if (fs.existsSync(file) && fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.1`);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n', { mode: 0o600 });
  } catch (err) {
    console.error('Failed to write audit log:', errorMessage(err));
  }
}

/** Runs a state-changing operation and records whether it succeeded. */
export async function audited<T>(
  req: Request,
  action: string,
  target: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    const result = await fn();
    audit(req, action, target, true);
    return result;
  } catch (err) {
    audit(req, action, target, false, errorMessage(err));
    throw err;
  }
}

export function readAudit(limit: number): AuditEntry[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const entries: AuditEntry[] = [];
  for (const line of lines.slice(-limit)) {
    try {
      entries.push(JSON.parse(line) as AuditEntry);
    } catch {
      // skip a partially written line
    }
  }
  return entries.reverse();
}
