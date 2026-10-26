import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// The Codex binary that the pinned @openai/codex package brings for macOS on Apple silicon, the one
// platform the app runs on (ADR-0004). The app runs it directly, not through the package's launcher.
export function bundledCodexBinary(): string {
  const codexPackage = createRequire(import.meta.url).resolve('@openai/codex/package.json');
  const nativePackage = createRequire(codexPackage).resolve(
    '@openai/codex-darwin-arm64/package.json',
  );
  return join(dirname(nativePackage), 'vendor', 'aarch64-apple-darwin', 'bin', 'codex');
}
