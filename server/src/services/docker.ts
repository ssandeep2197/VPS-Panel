import Docker from 'dockerode';
import fs from 'fs';
import { PassThrough, type Readable } from 'stream';
import { config } from '../config';
import { HttpError } from '../utils/http';

export const docker = config.dockerSocket ? new Docker({ socketPath: config.dockerSocket }) : new Docker();

export const containerActions = ['start', 'stop', 'restart', 'pause', 'unpause', 'kill'] as const;
export type ContainerAction = (typeof containerActions)[number];

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IMAGE_RE = /^[a-z0-9][a-z0-9._\-/:@]{0,254}$/i;

export function assertId(id: string): string {
  if (!ID_RE.test(id)) throw new HttpError(400, 'Invalid identifier');
  return id;
}

interface DockerodeError {
  statusCode?: number;
  code?: string;
  reason?: string;
  json?: { message?: string };
  message?: string;
}

/** Translates dockerode failures into HTTP errors the UI can show. */
export function toDockerError(err: unknown): unknown {
  if (err instanceof HttpError) return err;
  const e = err as DockerodeError;
  if (e?.code && ['ENOENT', 'ECONNREFUSED', 'EACCES', 'ECONNRESET'].includes(e.code)) {
    const hint = e.code === 'EACCES' ? ' (permission denied on the Docker socket)' : '';
    return new HttpError(503, `Docker daemon is not reachable${hint}`, 'DOCKER_UNAVAILABLE');
  }
  if (typeof e?.statusCode === 'number') {
    // 304 = container already in the requested state
    if (e.statusCode === 304) return new HttpError(409, 'Container is already in that state');
    const status = e.statusCode === 401 || e.statusCode === 403 ? 502 : e.statusCode;
    return new HttpError(status, e.json?.message || e.reason || e.message || 'Docker error');
  }
  return err;
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toDockerError(err);
  }
}

export function getInfo() {
  return guard(async () => {
    const [info, version] = await Promise.all([docker.info(), docker.version()]);
    return {
      version: version.Version as string,
      apiVersion: version.ApiVersion as string,
      os: info.OperatingSystem as string,
      containers: info.Containers as number,
      running: info.ContainersRunning as number,
      paused: info.ContainersPaused as number,
      stopped: info.ContainersStopped as number,
      images: info.Images as number,
      cpus: info.NCPU as number,
      memTotal: info.MemTotal as number,
      storageDriver: info.Driver as string,
    };
  });
}

export function listContainers() {
  return guard(async () => {
    const containers = await docker.listContainers({ all: true });
    return containers
      .map((c) => ({
        id: c.Id,
        name: (c.Names[0] ?? c.Id.slice(0, 12)).replace(/^\//, ''),
        image: c.Image,
        state: c.State,
        status: c.Status,
        created: c.Created * 1000,
        project: c.Labels?.['com.docker.compose.project'] ?? null,
        ports: [
          ...new Set(
            c.Ports.filter((p) => p.PublicPort).map((p) => `${p.PublicPort}→${p.PrivatePort}/${p.Type}`),
          ),
        ],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

export function inspectContainer(id: string) {
  return guard(async () => {
    const c = await docker.getContainer(assertId(id)).inspect();
    return {
      id: c.Id,
      name: c.Name.replace(/^\//, ''),
      image: c.Config.Image,
      created: c.Created,
      state: c.State.Status,
      startedAt: c.State.StartedAt,
      finishedAt: c.State.FinishedAt,
      exitCode: c.State.ExitCode,
      health: c.State.Health?.Status ?? null,
      restartCount: c.RestartCount,
      restartPolicy: c.HostConfig.RestartPolicy?.Name ?? '',
      command: [...(c.Config.Entrypoint ?? []), ...(c.Config.Cmd ?? [])].join(' '),
      // Names only: values routinely contain passwords and API keys
      envNames: (c.Config.Env ?? []).map((e) => e.split('=')[0]),
      mounts: c.Mounts.map((m) => ({ type: m.Type, source: m.Source, destination: m.Destination, rw: m.RW })),
      networks: Object.entries(c.NetworkSettings.Networks ?? {}).map(([name, n]) => ({
        name,
        ip: n.IPAddress,
      })),
      ports: Object.entries(c.NetworkSettings.Ports ?? {}).flatMap(([port, bindings]) =>
        (bindings ?? []).map((b) => `${b.HostIp || '0.0.0.0'}:${b.HostPort}→${port}`),
      ),
    };
  });
}

export function controlContainer(id: string, action: ContainerAction) {
  return guard(async () => {
    const container = docker.getContainer(assertId(id));
    switch (action) {
      case 'start':
        return container.start();
      case 'stop':
        return container.stop();
      case 'restart':
        return container.restart();
      case 'pause':
        return container.pause();
      case 'unpause':
        return container.unpause();
      case 'kill':
        return container.kill();
    }
  });
}

export function removeContainer(id: string, force: boolean) {
  return guard(() => docker.getContainer(assertId(id)).remove({ force }));
}

interface RawStats {
  cpu_stats: {
    cpu_usage: { total_usage: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats: { cpu_usage: { total_usage: number }; system_cpu_usage?: number };
  memory_stats: { usage?: number; limit?: number; stats?: Record<string, number> };
  networks?: Record<string, { rx_bytes: number; tx_bytes: number }>;
}

function summarizeStats(s: RawStats) {
  const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
  const sysDelta = (s.cpu_stats.system_cpu_usage ?? 0) - (s.precpu_stats.system_cpu_usage ?? 0);
  const cpus = s.cpu_stats.online_cpus || s.cpu_stats.cpu_usage.percpu_usage?.length || 1;
  const cpu = sysDelta > 0 && cpuDelta > 0 ? (cpuDelta / sysDelta) * cpus * 100 : 0;
  const cache = s.memory_stats.stats?.inactive_file ?? s.memory_stats.stats?.cache ?? 0;
  const memUsed = Math.max(0, (s.memory_stats.usage ?? 0) - cache);
  const nets = Object.values(s.networks ?? {});
  return {
    cpu: Math.round(cpu * 100) / 100,
    memUsed,
    memLimit: s.memory_stats.limit ?? 0,
    netRx: nets.reduce((sum, n) => sum + n.rx_bytes, 0),
    netTx: nets.reduce((sum, n) => sum + n.tx_bytes, 0),
  };
}

/** One stats snapshot per running container, keyed by container id. */
export function allContainerStats() {
  return guard(async () => {
    const running = await docker.listContainers();
    const entries = await Promise.all(
      running.map(async (c) => {
        try {
          const raw = (await docker.getContainer(c.Id).stats({ stream: false })) as unknown as RawStats;
          return [c.Id, summarizeStats(raw)] as const;
        } catch {
          return null; // container stopped between list and stats
        }
      }),
    );
    return Object.fromEntries(entries.filter((e) => e !== null));
  });
}

export function listImages() {
  return guard(async () => {
    const [images, containers] = await Promise.all([docker.listImages(), docker.listContainers({ all: true })]);
    const inUse = new Set(containers.map((c) => c.ImageID));
    return images
      .map((i) => ({
        id: i.Id,
        tags: (i.RepoTags ?? []).filter((t) => t !== '<none>:<none>'),
        size: i.Size,
        created: i.Created * 1000,
        inUse: inUse.has(i.Id),
      }))
      .sort((a, b) => b.created - a.created);
  });
}

export function removeImage(id: string, force: boolean) {
  if (!/^(sha256:)?[a-f0-9]{12,64}$/.test(id)) throw new HttpError(400, 'Invalid image id');
  return guard(() => docker.getImage(id).remove({ force }));
}

export function pullImage(image: string) {
  if (!IMAGE_RE.test(image)) throw new HttpError(400, 'Invalid image reference');
  const ref = image.includes(':') || image.includes('@') ? image : `${image}:latest`;
  return guard(
    () =>
      new Promise<void>((resolve, reject) => {
        docker.pull(ref, (err: Error | null, stream: NodeJS.ReadableStream) => {
          if (err) return reject(err);
          docker.modem.followProgress(stream, (doneErr) => (doneErr ? reject(doneErr) : resolve()));
        });
      }),
  );
}

export function listVolumes() {
  return guard(async () => {
    const [{ Volumes }, containers] = await Promise.all([
      docker.listVolumes(),
      docker.listContainers({ all: true }),
    ]);
    const usedBy = new Map<string, string[]>();
    for (const c of containers) {
      for (const m of c.Mounts ?? []) {
        if (m.Type !== 'volume' || !m.Name) continue;
        const name = (c.Names[0] ?? c.Id.slice(0, 12)).replace(/^\//, '');
        usedBy.set(m.Name, [...(usedBy.get(m.Name) ?? []), name]);
      }
    }
    return (Volumes ?? [])
      .map((v) => ({
        name: v.Name,
        driver: v.Driver,
        mountpoint: v.Mountpoint,
        created: (v as { CreatedAt?: string }).CreatedAt ?? null,
        usedBy: usedBy.get(v.Name) ?? [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

export function removeVolume(name: string) {
  return guard(() => docker.getVolume(assertId(name)).remove());
}

export function listNetworks() {
  return guard(async () => {
    const networks = await docker.listNetworks();
    return networks
      .map((n) => ({
        id: n.Id,
        name: n.Name,
        driver: n.Driver,
        scope: n.Scope,
        subnet: n.IPAM?.Config?.[0]?.Subnet ?? null,
        internal: Boolean(n.Internal),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  });
}

/**
 * Follows a container's logs as a single text stream. Non-TTY containers
 * multiplex stdout/stderr with an 8 byte frame header that has to be removed.
 */
export async function followContainerLogs(
  id: string,
  tail: number,
): Promise<{ stream: Readable; stop: () => void }> {
  return guard(async () => {
    const container = docker.getContainer(assertId(id));
    const info = await container.inspect();
    const raw = (await container.logs({
      follow: true,
      stdout: true,
      stderr: true,
      tail,
      timestamps: true,
    })) as unknown as Readable;

    const stop = () => {
      (raw as Readable & { destroy?: () => void }).destroy?.();
    };

    if (info.Config.Tty) return { stream: raw, stop };

    const out = new PassThrough();
    docker.modem.demuxStream(raw, out, out);
    raw.on('end', () => out.end());
    raw.on('error', (err) => out.destroy(err));
    return { stream: out, stop };
  });
}

/**
 * The exec PID is only meaningful on a Linux host sharing the kernel with the
 * container (on Docker Desktop it is a PID inside the VM). Confirm via cgroup
 * membership before signalling, so an unrelated host process is never killed.
 */
function belongsToContainer(pid: number, containerId: string): boolean {
  if (process.platform !== 'linux') return false;
  try {
    return fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8').includes(containerId);
  } catch {
    return false;
  }
}

export interface ExecSession {
  write: (data: Buffer) => void;
  resize: (cols: number, rows: number) => void;
  onData: (listener: (chunk: Buffer) => void) => void;
  onEnd: (listener: () => void) => void;
  close: () => void;
}

/**
 * Opens an interactive shell inside a running container (like `docker exec -it`).
 * Prefers bash and falls back to sh. Runs as the container's configured user.
 */
export async function openShell(id: string, cols: number, rows: number): Promise<ExecSession> {
  return guard(async () => {
    const container = docker.getContainer(assertId(id));
    const exec = await container.exec({
      Cmd: ['/bin/sh', '-c', 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'],
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Env: ['TERM=xterm-256color'],
    });
    const stream = (await exec.start({ hijack: true, stdin: true, Tty: true })) as unknown as NodeJS.ReadWriteStream & {
      destroy?: () => void;
    };
    const resize = (c: number, r: number) => {
      exec.resize({ w: c, h: r }).catch(() => undefined);
    };
    // The TTY size is only known once the process exists
    setTimeout(() => resize(cols, rows), 50);
    return {
      write: (data) => stream.write(data),
      resize,
      onData: (listener) => stream.on('data', listener),
      onEnd: (listener) => {
        stream.on('end', listener);
        stream.on('close', listener);
      },
      close: () => {
        // Interrupt whatever is running, then send end-of-input so the shell exits
        stream.write('\x03');
        setTimeout(() => stream.write('\x04'), 100);
        setTimeout(() => {
          stream.end();
          stream.destroy?.();
        }, 300);
        // Docker has no "kill exec" API; if the shell ignored EOF, kill its process from the host
        setTimeout(() => {
          exec
            .inspect()
            .then((info) => {
              if (info.Running && info.Pid > 0 && belongsToContainer(info.Pid, info.ContainerID)) {
                process.kill(info.Pid, 'SIGKILL');
              }
            })
            .catch(() => undefined);
        }, 1500);
      },
    };
  });
}
