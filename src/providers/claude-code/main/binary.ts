import { createRequire } from 'node:module';
import { dirname, join, sep } from 'node:path';

// The Claude Code binary that the pinned SDK brings for macOS on Apple silicon, the one platform the
// app runs on (ADR-0004), which the app gives the SDK for its sessions and probes and runs for the
// sign-in. The SDK exports no package.json, so the binary's package is found from the SDK's entry. In
// the packaged app the binary lies beside the app's archive, where macOS can run it, as
// electron-builder.yml unpacks it; the SDK, which looks for it beside itself, would find it inside.
export function bundledClaudeBinary(): string {
  const sdk = createRequire(import.meta.url).resolve('@anthropic-ai/claude-agent-sdk');
  const native = createRequire(sdk).resolve(
    '@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json',
  );
  return outsideArchive(join(dirname(native), 'claude'));
}

// A path into the packaged app's archive as the path of its unpacked copy beside it; any other path
// as it is.
export function outsideArchive(path: string): string {
  return path.replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
}
