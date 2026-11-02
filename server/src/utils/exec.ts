import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { config } from '../config';
import { HttpError } from './http';

interface RunOptions {
  timeout?: number;
  /** Prefix with `sudo -n` when USE_SUDO is on and we are not root. */
  privileged?: boolean;
}

function resolve(cmd: string, args: string[], privileged?: boolean): [string, string[]] {
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  if (privileged && config.useSudo && !isRoot) return ['sudo', ['-n', cmd, ...args]];
  return [cmd, args];
}

/**
 * Runs a command without a shell. Arguments are passed as an array so user
 * supplied values can never be interpreted as shell syntax.
 */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const [file, argv] = resolve(cmd, args, opts.privileged);
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      argv,
      { timeout: opts.timeout ?? 15_000, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') {
            reject(new HttpError(501, `${file} is not available on this host`, 'UNSUPPORTED'));
            return;
          }
          reject(new HttpError(500, (stderr || err.message).trim()));
          return;
        }
        resolvePromise(stdout);
      },
    );
  });
}

export function spawnStream(
  cmd: string,
  args: string[],
  opts: RunOptions = {},
): ChildProcessWithoutNullStreams {
  const [file, argv] = resolve(cmd, args, opts.privileged);
  return spawn(file, argv, { stdio: 'pipe' });
}
