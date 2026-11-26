import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { brotliDecompressSync } from 'node:zlib';
import type { ProviderInstall } from '../src/installs/main/install';
import type { ProviderId } from '../src/sessions/shared/events';

// The providers' binaries that tests run: those of the provider packages pinned in package.json, the
// builds the app's own copies are made of, never the developer's CLIs on the PATH (ADR-0039, L-0006,
// L-0007). The tests run from the product's folder, whose package.json resolves the packages.
const fromRoot = createRequire(join(process.cwd(), 'package.json'));

// The version each adapter's pin names, read as a file, since Playwright's loader takes no JSON module.
function pinnedVersion(provider: ProviderId): string {
  const pin = join(process.cwd(), 'src', 'providers', provider, 'main', 'pin.json');
  return (JSON.parse(readFileSync(pin, 'utf8')) as { version: string }).version;
}
// The providers whose packages carry their binaries, by the command each answers to. Antigravity has
// no package, so the smoke and packaged tests have no copy of it, and it shows there as not installed.
const COMMANDS: Partial<Record<ProviderId, string>> = {
  'claude-code': 'claude',
  'codex-cli': 'codex',
  'grok-build': 'grok',
};

// The pinned package's binary for the provider.
export function pinnedBinary(provider: ProviderId): string {
  switch (provider) {
    case 'claude-code': {
      // The SDK exports no package.json, so its package for the platform is found from its entry.
      const sdk = fromRoot.resolve('@anthropic-ai/claude-agent-sdk');
      const native = createRequire(sdk).resolve(
        '@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json',
      );
      return join(dirname(native), 'claude');
    }
    case 'codex-cli': {
      const codex = fromRoot.resolve('@openai/codex/package.json');
      const native = createRequire(codex).resolve('@openai/codex-darwin-arm64/package.json');
      return join(dirname(native), 'vendor', 'aarch64-apple-darwin', 'bin', 'codex');
    }
    case 'grok-build':
      return unpackedGrok();
    case 'antigravity':
      throw new Error('Antigravity has no package; pinnedInstall downloads its pinned build.');
  }
}

// Grok Build's binary, which its package carries compressed, unpacked once for each version into
// node_modules' cache, where it appears only once whole.
function unpackedGrok(): string {
  const manifest = fromRoot.resolve('@xai-official/grok-darwin-arm64/package.json');
  const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
  const binary = join(process.cwd(), 'node_modules', '.cache', '3mukon-code', `grok-${version}`);
  if (!existsSync(binary)) {
    mkdirSync(dirname(binary), { recursive: true });
    const partial = `${binary}.${String(process.pid)}`;
    const packed = readFileSync(join(dirname(manifest), 'bin', 'grok.br'));
    writeFileSync(partial, brotliDecompressSync(packed), { mode: 0o700 });
    renameSync(partial, binary);
  }
  return binary;
}

// Antigravity's pinned build, which Google serves outside npm: downloaded once for each version into
// node_modules' cache, checked against its pin, and unpacked there, where it appears only once whole.
async function downloadedAntigravity(): Promise<string> {
  const pinFile = join(process.cwd(), 'src', 'providers', 'antigravity', 'main', 'pin.json');
  const pin = JSON.parse(readFileSync(pinFile, 'utf8')) as {
    version: string;
    url: string;
    integrity: string;
    binary: string;
  };
  const folder = join(process.cwd(), 'node_modules', '.cache', '3mukon-code');
  const copy = join(folder, `antigravity-${pin.version}`);
  const binary = join(copy, pin.binary);
  if (existsSync(binary)) return binary;
  const response = await fetch(pin.url);
  if (!response.ok) throw new Error(`${pin.url} answered ${String(response.status)}.`);
  const build = Buffer.from(await response.arrayBuffer());
  if (`sha512-${createHash('sha512').update(build).digest('base64')}` !== pin.integrity) {
    throw new Error(`The build of Antigravity ${pin.version} does not match its pin.`);
  }
  const partial = `${copy}.${String(process.pid)}`;
  rmSync(partial, { recursive: true, force: true });
  mkdirSync(partial, { recursive: true });
  writeFileSync(join(partial, 'build.tgz'), build);
  execFileSync('/usr/bin/tar', ['-xzf', join(partial, 'build.tgz'), '-C', partial]);
  rmSync(join(partial, 'build.tgz'));
  renameSync(partial, copy);
  return binary;
}

// A provider's CLI that is always its pinned binary, run as the app's own copy, for the live tests.
export function pinnedInstall(provider: ProviderId): ProviderInstall {
  const version = pinnedVersion(provider);
  const binary = async () => ({
    path: provider === 'antigravity' ? await downloadedAntigravity() : pinnedBinary(provider),
    version,
    source: 'app' as const,
  });
  return {
    provider,
    current: binary,
    prepare: binary,
    view: () => Promise.resolve({ runs: { source: 'app', version }, pinned: version }),
    onChange: () => () => undefined,
  };
}

// A folder of the tests' own CLIs in the folder given, each of which runs a pinned binary, which the
// smoke tests give the app with --provider-path in place of the PATH's folders. They are scripts that
// replace themselves with the binary, which then runs from its own place, beside the tools it uses.
export function providerCopies(folder: string): string {
  const copies = join(folder, 'provider-copies');
  mkdirSync(copies, { recursive: true });
  for (const [provider, command] of Object.entries(COMMANDS) as [ProviderId, string][]) {
    writeFileSync(join(copies, command), `#!/bin/sh\nexec '${pinnedBinary(provider)}' "$@"\n`, {
      mode: 0o755,
    });
  }
  return copies;
}
