/**
 * Changes the admin password without touching any other setting.
 *
 *   npm run passwd
 *
 * The password is typed at a hidden prompt, so it never passes through a shell
 * command line (where characters like $ ! ` would be altered) or shell history.
 */
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';

const envPath = path.resolve(__dirname, '../.env');

function ask(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error('This command needs an interactive terminal. Over SSH, use: ssh -t <host> ...'));
      return;
    }
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          stdin.setRawMode(false);
          process.stdout.write('\nCancelled\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function main(): Promise<void> {
  if (!fs.existsSync(envPath)) {
    throw new Error(`${envPath} does not exist. Run "npm run setup" first.`);
  }
  const password = await ask('New password: ');
  if (password.length < 8) throw new Error('Password must be at least 8 characters.');
  const again = await ask('Repeat password: ');
  if (password !== again) throw new Error('The passwords do not match. Nothing was changed.');

  const hash = bcrypt.hashSync(password, 12);
  // Prove the stored value accepts what was typed before writing anything
  if (!bcrypt.compareSync(password, hash)) throw new Error('Hash verification failed. Nothing was changed.');

  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  const index = lines.findIndex((line) => line.startsWith('ADMIN_PASSWORD_HASH='));
  if (index === -1) lines.push(`ADMIN_PASSWORD_HASH=${hash}`);
  else lines[index] = `ADMIN_PASSWORD_HASH=${hash}`;
  fs.writeFileSync(envPath, lines.join('\n'), { mode: 0o600 });

  console.log('Password changed. Restart the panel to apply it: systemctl restart vps-panel');
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
