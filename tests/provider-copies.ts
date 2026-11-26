import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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
const COMMANDS = { 'claude-code': 'claude', codex: 'codex', 'grok-build': 'grok' } as const;

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
    case 'codex': {
      const codex = fromRoot.resolve('@openai/codex/package.json');
      const native = createRequire(codex).resolve('@openai/codex-darwin-arm64/package.json');
      return join(dirname(native), 'vendor', 'aarch64-apple-darwin', 'bin', 'codex');
    }
    case 'grok-build':
      return unpackedGrok();
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

// A provider's CLI that is always its pinned binary, run as the app's own copy, for the live tests.
export function pinnedInstall(provider: ProviderId): ProviderInstall {
  const binary = {
    path: pinnedBinary(provider),
    version: pinnedVersion(provider),
    source: 'app' as const,
  };
  return {
    provider,
    current: () => Promise.resolve(binary),
    prepare: () => Promise.resolve(binary),
    view: () =>
      Promise.resolve({ runs: { source: 'app', version: binary.version }, pinned: binary.version }),
    onChange: () => () => undefined,
  };
}

// A folder of the tests' own CLIs in the folder given, each of which runs a pinned binary, which the
// smoke tests give the app with --provider-path in place of the PATH's folders. They are scripts that
// replace themselves with the binary, which then runs from its own place, beside the tools it uses.
export function providerCopies(folder: string): string {
  const copies = join(folder, 'provider-copies');
  mkdirSync(copies, { recursive: true });
  for (const provider of Object.keys(COMMANDS) as ProviderId[]) {
    writeFileSync(
      join(copies, COMMANDS[provider]),
      `#!/bin/sh\nexec '${pinnedBinary(provider)}' "$@"\n`,
      {
        mode: 0o755,
      },
    );
  }
  return copies;
}
