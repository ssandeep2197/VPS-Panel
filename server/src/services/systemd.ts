import { config } from '../config';
import { run, spawnStream } from '../utils/exec';
import { HttpError } from '../utils/http';

export interface ServiceUnit {
  name: string;
  description: string;
  load: string;
  active: string;
  sub: string;
  enabled: string;
  protected: boolean;
}

export const serviceActions = ['start', 'stop', 'restart', 'reload', 'enable', 'disable'] as const;
export type ServiceAction = (typeof serviceActions)[number];

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9@_.:\\-]{0,200}$/;

function assertSupported(): void {
  if (process.platform !== 'linux') {
    throw new HttpError(
      501,
      `systemd is not available on ${process.platform}. Service management works when the panel runs on the Linux server.`,
      'UNSUPPORTED',
    );
  }
}

/** Validates a unit name and normalises it to `<name>.service`. */
export function normalizeServiceName(input: string): string {
  if (!NAME_RE.test(input)) throw new HttpError(400, 'Invalid service name');
  return input.endsWith('.service') ? input : `${input}.service`;
}

function isProtected(name: string): boolean {
  const base = name.replace(/\.service$/, '');
  return config.protectedServices.includes(base);
}

export async function listServices(): Promise<ServiceUnit[]> {
  assertSupported();
  const [unitsOut, filesOut] = await Promise.all([
    run('systemctl', ['list-units', '--type=service', '--all', '--plain', '--no-legend', '--no-pager']),
    run('systemctl', ['list-unit-files', '--type=service', '--plain', '--no-legend', '--no-pager']),
  ]);

  const enabled = new Map<string, string>();
  for (const line of filesOut.split('\n')) {
    const [name, state] = line.trim().split(/\s+/);
    if (name && state) enabled.set(name, state);
  }

  const units = new Map<string, ServiceUnit>();
  for (const line of unitsOut.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 4 || !parts[0].endsWith('.service')) continue;
    const [name, load, active, sub, ...desc] = parts;
    units.set(name, {
      name,
      load,
      active,
      sub,
      description: desc.join(' '),
      enabled: enabled.get(name) ?? 'unknown',
      protected: isProtected(name),
    });
  }

  // Installed but never loaded units only appear in list-unit-files
  for (const [name, state] of enabled) {
    if (units.has(name) || name.includes('@.')) continue;
    units.set(name, {
      name,
      load: 'not-loaded',
      active: 'inactive',
      sub: 'dead',
      description: '',
      enabled: state,
      protected: isProtected(name),
    });
  }

  return [...units.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const SHOW_PROPS = [
  'Id',
  'Description',
  'LoadState',
  'ActiveState',
  'SubState',
  'UnitFileState',
  'MainPID',
  'MemoryCurrent',
  'CPUUsageNSec',
  'TasksCurrent',
  'NRestarts',
  'Restart',
  'ActiveEnterTimestamp',
  'FragmentPath',
  'ExecStart',
  'User',
];

export async function getService(input: string) {
  assertSupported();
  const name = normalizeServiceName(input);
  const out = await run('systemctl', ['show', name, '--no-pager', `--property=${SHOW_PROPS.join(',')}`]);
  const props: Record<string, string> = {};
  for (const line of out.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) props[line.slice(0, i)] = line.slice(i + 1);
  }
  if (props.LoadState === 'not-found') throw new HttpError(404, `Service ${name} not found`);

  const num = (v: string | undefined) => (v && /^\d+$/.test(v) ? Number(v) : null);
  return {
    name,
    description: props.Description ?? '',
    load: props.LoadState ?? '',
    active: props.ActiveState ?? '',
    sub: props.SubState ?? '',
    enabled: props.UnitFileState ?? '',
    mainPid: num(props.MainPID) || null,
    memoryBytes: num(props.MemoryCurrent),
    cpuSeconds: num(props.CPUUsageNSec) !== null ? (num(props.CPUUsageNSec) as number) / 1e9 : null,
    tasks: num(props.TasksCurrent),
    restarts: num(props.NRestarts),
    restartPolicy: props.Restart ?? '',
    activeSince: props.ActiveEnterTimestamp ?? '',
    unitFile: props.FragmentPath ?? '',
    execStart: props.ExecStart ?? '',
    user: props.User ?? '',
    protected: isProtected(name),
  };
}

export async function controlService(input: string, action: ServiceAction): Promise<void> {
  assertSupported();
  const name = normalizeServiceName(input);
  if (isProtected(name) && (action === 'stop' || action === 'disable')) {
    throw new HttpError(403, `${name} is protected and cannot be ${action === 'stop' ? 'stopped' : 'disabled'}`);
  }
  await run('systemctl', [action, name], { privileged: true, timeout: 60_000 });
}

export function followServiceLogs(input: string, tail: number) {
  assertSupported();
  const name = normalizeServiceName(input);
  return spawnStream(
    'journalctl',
    ['-u', name, '-n', String(tail), '-f', '--no-pager', '-o', 'short-iso'],
    { privileged: true },
  );
}
