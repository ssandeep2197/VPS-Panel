/**
 * Creates server/.env with a hashed admin password and a random JWT secret.
 *
 *   npm run setup -- --username admin --password 'secret' [--brokers localhost:9092] [--force]
 *
 * If --password is omitted a random one is generated and printed once.
 */
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const envPath = path.resolve(__dirname, '../.env');
const examplePath = path.resolve(__dirname, '../.env.example');
const force = process.argv.includes('--force');

if (fs.existsSync(envPath) && !force) {
  console.error(`${envPath} already exists. Re-run with --force to overwrite it.`);
  process.exit(1);
}

const username = arg('username') ?? 'admin';
const provided = arg('password');
const password = provided ?? crypto.randomBytes(12).toString('base64url');
const brokers = arg('brokers') ?? '';

if (password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const values: Record<string, string> = {
  ADMIN_USERNAME: username,
  ADMIN_PASSWORD_HASH: bcrypt.hashSync(password, 12),
  JWT_SECRET: crypto.randomBytes(48).toString('base64url'),
  KAFKA_BROKERS: brokers,
};

const env = fs
  .readFileSync(examplePath, 'utf8')
  .split('\n')
  .map((line) => {
    const match = /^([A-Z_]+)=/.exec(line);
    return match && match[1] in values ? `${match[1]}=${values[match[1]]}` : line;
  })
  .join('\n');

fs.writeFileSync(envPath, env, { mode: 0o600 });

console.log(`Wrote ${envPath}`);
console.log(`  username: ${username}`);
if (!provided) console.log(`  password: ${password}   (generated - store it now, it is not saved in plain text)`);
