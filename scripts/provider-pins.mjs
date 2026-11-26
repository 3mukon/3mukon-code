/* global Buffer, console, fetch, process */
// Writes the pin of each provider's copy that the app downloads where the user has no CLI of theirs
// (ADR-0039), from the provider packages pinned in package.json and pnpm-lock.yaml: the version of
// the CLI the copy is, the npm registry's tarball of the package's build for macOS on Apple silicon,
// that tarball's sha512 integrity as the lockfile records it, and where the binary lies in it. Run it
// after each upgrade of a provider package: corepack pnpm run providers:pins. With --check it writes
// nothing and fails when a pin differs from what it would write, as the contract test runs it.
//
// Antigravity is published outside npm, so its pin comes from Google's update manifest for macOS on
// Apple silicon, which names the latest build's version, its versioned address and its SHA-512. Only
// --antigravity reads the manifest, moving the pin to that build: corepack pnpm run providers:pins
// --antigravity. Otherwise the pin stays as it is, and --check checks its form, offline.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const manifest = JSON.parse(read('package.json'));
const lockfile = read('pnpm-lock.yaml');

// The version package.json pins a package at, exactly.
function pinned(name) {
  const version = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    throw new Error(`package.json does not pin ${name} to an exact version.`);
  }
  return version;
}

// The integrity the lockfile records for a package at a version, which the registry gives too.
function integrity(name, version) {
  const key = `${name}@${version}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const found = new RegExp(
    `^ {2}'?${key}'?:\\n {4}resolution: \\{integrity: (sha512-[A-Za-z0-9+/=]+)\\}`,
    'm',
  ).exec(lockfile);
  if (found === null)
    throw new Error(`pnpm-lock.yaml records no integrity for ${name}@${version}.`);
  return found[1];
}

function tarball(name, version) {
  return `https://registry.npmjs.org/${name}/-/${name.split('/').pop()}-${version}.tgz`;
}

// The Claude Agent SDK brings the Claude Code binary of its own version (claudeCodeVersion) in its
// package for each platform, which is the app's copy of Claude Code.
const sdk = pinned('@anthropic-ai/claude-agent-sdk');
const claudeCode = JSON.parse(read('node_modules/@anthropic-ai/claude-agent-sdk/package.json'));
if (claudeCode.version !== sdk)
  throw new Error('node_modules holds another Claude Agent SDK than package.json pins.');

// Codex publishes each platform's build as a version of its own package, named after the platform.
const codex = pinned('@openai/codex');
const grok = pinned('@xai-official/grok-darwin-arm64');

const pins = {
  'src/providers/claude-code/main/pin.json': {
    version: claudeCode.claudeCodeVersion,
    url: tarball('@anthropic-ai/claude-agent-sdk-darwin-arm64', sdk),
    integrity: integrity('@anthropic-ai/claude-agent-sdk-darwin-arm64', sdk),
    folder: 'package',
    binary: 'claude',
  },
  'src/providers/codex/main/pin.json': {
    version: codex,
    url: tarball('@openai/codex', `${codex}-darwin-arm64`),
    integrity: integrity('@openai/codex', `${codex}-darwin-arm64`),
    // The tools Codex runs lie beside its binary, as the package lays them out.
    folder: 'package/vendor/aarch64-apple-darwin',
    binary: 'bin/codex',
  },
  'src/providers/grok-build/main/pin.json': {
    version: grok,
    url: tarball('@xai-official/grok-darwin-arm64', grok),
    integrity: integrity('@xai-official/grok-darwin-arm64', grok),
    folder: 'package/bin',
    // Compressed with brotli; the copy is the binary unpacked, without the suffix.
    binary: 'grok.br',
    brotli: true,
  },
};

// Google's update manifest for agy on macOS on Apple silicon, which its installer reads, and the form
// of the versioned addresses it names.
const ANTIGRAVITY_PIN = 'src/providers/antigravity/main/pin.json';
const ANTIGRAVITY_MANIFEST =
  'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/darwin_arm64.json';
const ANTIGRAVITY_BUILD =
  /^https:\/\/storage\.googleapis\.com\/antigravity-public\/antigravity-cli\/(\d+\.\d+\.\d+)-\d+\/darwin-arm\/cli_mac_arm64\.tar\.gz$/;

// The pin of a build the manifest names: its SHA-512, in hexadecimal there, as an integrity. The
// tarball holds the binary, `antigravity`, at its root.
function antigravityPin({ version, url, sha512 }) {
  if (ANTIGRAVITY_BUILD.exec(url ?? '')?.[1] !== version || !/^[0-9a-f]{128}$/.test(sha512 ?? '')) {
    throw new Error(`Google's manifest names no build of agy in the form this script reads.`);
  }
  const integrity = `sha512-${Buffer.from(sha512, 'hex').toString('base64')}`;
  return { version, url, integrity, folder: '', binary: 'antigravity' };
}

// Whether a pin of agy has the form antigravityPin writes.
function wellFormed(pin) {
  return (
    ANTIGRAVITY_BUILD.exec(pin.url ?? '')?.[1] === pin.version &&
    /^sha512-[A-Za-z0-9+/]{86}==$/.test(pin.integrity ?? '') &&
    pin.folder === '' &&
    pin.binary === 'antigravity' &&
    Object.keys(pin).length === 5
  );
}

const check = process.argv.includes('--check');
if (process.argv.includes('--antigravity') && !check) {
  const response = await fetch(ANTIGRAVITY_MANIFEST);
  if (!response.ok) throw new Error(`Google's manifest answered ${String(response.status)}.`);
  pins[ANTIGRAVITY_PIN] = antigravityPin(await response.json());
}
let differs = false;
for (const [path, pin] of Object.entries(pins)) {
  const text = `${JSON.stringify(pin, null, 2)}\n`;
  let current = null;
  try {
    current = read(path);
  } catch {
    // Not written yet.
  }
  if (current === text) continue;
  if (check) {
    differs = true;
    console.error(`${path} differs from the lockfile's pin; run: corepack pnpm run providers:pins`);
  } else {
    writeFileSync(join(root, path), text);
    console.log(`wrote ${path}`);
  }
}
let antigravity = null;
try {
  antigravity = JSON.parse(read(ANTIGRAVITY_PIN));
} catch {
  // Not written yet.
}
if (antigravity === null || !wellFormed(antigravity)) {
  differs = true;
  console.error(
    `${ANTIGRAVITY_PIN} is not a pin of Google's build of agy; run: corepack pnpm run providers:pins --antigravity`,
  );
}
if (differs) process.exit(1);
