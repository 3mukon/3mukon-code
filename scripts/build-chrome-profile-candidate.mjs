import { Buffer } from 'node:buffer';
import { execFile as run } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { promisify } from 'node:util';
import { stampExtension } from './stamp-chrome-extension.mjs';

const exec = promisify(run);
const root = fileURLToPath(new URL('../src/browser/native/chrome/', import.meta.url));
const requested = process.argv[2];
if (!requested) throw new Error('An isolated staging directory is required.');
const stage = resolve(requested);
await mkdir(stage, { mode: 0o700 });
const host = join(stage, 'BrowserHost');
await exec('/usr/bin/clang', [
  '-Wall',
  '-Wextra',
  '-Werror',
  '-arch',
  'arm64',
  '-O2',
  join(root, 'Host.c'),
  '-o',
  host,
]);
await exec('/usr/bin/codesign', ['--force', '--sign', '-', host]);
await exec('/usr/bin/codesign', ['--verify', '--strict', host]);
const extension = join(stage, 'extension');
await cp(join(root, 'extension'), extension, { recursive: true });
await stampExtension(extension);
const manifest = JSON.parse(await readFile(join(extension, 'manifest.json'), 'utf8'));
const hash = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex');
const extensionId = [...hash.slice(0, 32)]
  .map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)))
  .join('');
await writeFile(join(stage, 'candidate.json'), JSON.stringify({ extensionId, extension, host }));
