import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';

// The Codex binary that the pinned @openai/codex package brings for macOS on Apple silicon, the one
// platform the app runs on (ADR-0004). The app runs it directly, not through the package's launcher.
// In the packaged app it lies beside the app's archive, where macOS can run it, with the tools beside
// it, as electron-builder.yml unpacks them.
export function bundledCodexBinary(): string {
  const codexPackage = createRequire(import.meta.url).resolve('@openai/codex/package.json');
  const nativePackage = createRequire(codexPackage).resolve(
    '@openai/codex-darwin-arm64/package.json',
  );
  return join(dirname(nativePackage), 'vendor', 'aarch64-apple-darwin', 'bin', 'codex').replace(
    `${sep}app.asar${sep}`,
    `${sep}app.asar.unpacked${sep}`,
  );
}
