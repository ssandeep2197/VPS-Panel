import os from 'os';
import si from 'systeminformation';
import { HttpError } from '../utils/http';

export interface MetricSample {
  ts: number;
  cpu: number;
  memUsed: number;
  memTotal: number;
  swapUsed: number;
  swapTotal: number;
  load: [number, number, number];
  rxSec: number;
  txSec: number;
}

const SAMPLE_INTERVAL_MS = 3000;
const HISTORY_SIZE = 200; // 10 minutes at 3s

const history: MetricSample[] = [];
const listeners = new Set<(sample: MetricSample) => void>();
let timer: NodeJS.Timeout | null = null;

async function sample(): Promise<MetricSample> {
  const [load, mem, net] = await Promise.all([si.currentLoad(), si.mem(), si.networkStats()]);
  const [l1, l5, l15] = os.loadavg();
  return {
    ts: Date.now(),
    cpu: round(load.currentLoad),
    // "available" excludes reclaimable buffers/cache, which "used" counts on Linux
    memUsed: mem.total - mem.available,
    memTotal: mem.total,
    swapUsed: mem.swapused,
    swapTotal: mem.swaptotal,
    load: [round(l1), round(l5), round(l15)],
    rxSec: Math.max(0, net.reduce((sum, n) => sum + (n.rx_sec ?? 0), 0)),
    txSec: Math.max(0, net.reduce((sum, n) => sum + (n.tx_sec ?? 0), 0)),
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

export function startMetricsSampler(): void {
  if (timer) return;
  const tick = async () => {
    try {
      const s = await sample();
      history.push(s);
      if (history.length > HISTORY_SIZE) history.shift();
      for (const listener of listeners) listener(s);
    } catch (err) {
      console.error('metrics sample failed', err);
    }
  };
  void tick();
  timer = setInterval(tick, SAMPLE_INTERVAL_MS);
  timer.unref();
}

export function getMetricsHistory(): MetricSample[] {
  return history;
}

export function onMetrics(listener: (sample: MetricSample) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const PSEUDO_FS = new Set(['tmpfs', 'devtmpfs', 'squashfs', 'overlay', 'devfs', 'autofs', 'efivarfs']);

export async function getOverview() {
  const [osInfo, cpu, fs] = await Promise.all([si.osInfo(), si.cpu(), si.fsSize()]);
  const seen = new Set<string>();
  const disks = fs
    .filter((d) => d.size > 0 && !PSEUDO_FS.has(d.type.toLowerCase()))
    .filter((d) => !d.mount.startsWith('/System/Volumes/') && !d.mount.startsWith('/snap/'))
    .filter((d) => (seen.has(d.fs) ? false : seen.add(d.fs)))
    .map((d) => ({ fs: d.fs, type: d.type, mount: d.mount, size: d.size, used: d.used, usePercent: d.use }));

  return {
    hostname: os.hostname(),
    platform: osInfo.platform,
    distro: `${osInfo.distro} ${osInfo.release}`.trim(),
    kernel: osInfo.kernel,
    arch: osInfo.arch,
    cpuModel: `${cpu.manufacturer} ${cpu.brand}`.trim(),
    cpuCores: cpu.cores,
    uptime: os.uptime(),
    disks,
  };
}

export async function getProcesses() {
  const data = await si.processes();
  const list = data.list
    .map((p) => ({
      pid: p.pid,
      parentPid: p.parentPid,
      name: p.name,
      user: p.user,
      cpu: round(p.cpu),
      mem: round(p.mem),
      memRss: p.memRss * 1024,
      state: p.state,
      started: p.started,
      command: [p.command, p.params].filter(Boolean).join(' ').slice(0, 500),
    }))
    .sort((a, b) => b.cpu - a.cpu || b.mem - a.mem);
  return { total: data.all, running: data.running, sleeping: data.sleeping, list: list.slice(0, 300) };
}

const SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGINT'] as const;
export type KillSignal = (typeof SIGNALS)[number];
export const killSignals: readonly KillSignal[] = SIGNALS;

export function killProcess(pid: number, signal: KillSignal): void {
  if (pid <= 1) throw new HttpError(400, 'Refusing to signal PID 0 or 1');
  if (pid === process.pid || pid === process.ppid) {
    throw new HttpError(400, 'Refusing to signal the control panel itself');
  }
  try {
    process.kill(pid, signal);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') throw new HttpError(404, `Process ${pid} not found`);
    if (code === 'EPERM') throw new HttpError(403, `Not permitted to signal process ${pid}`);
    throw err;
  }
}

export async function getListeningPorts() {
  const conns = await si.networkConnections();
  const seen = new Set<string>();
  return conns
    .filter((c) => c.state === 'LISTEN')
    .map((c) => ({
      protocol: c.protocol,
      address: c.localAddress,
      port: Number(c.localPort),
      pid: c.pid || null,
      process: c.process || '',
    }))
    .filter((c) => {
      const key = `${c.protocol}|${c.address}|${c.port}`;
      return seen.has(key) ? false : seen.add(key);
    })
    .sort((a, b) => a.port - b.port);
}
