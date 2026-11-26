import type { InstallSpec } from '../../../installs/main/install';
import pin from './pin.json';

// Codex's CLI (ADR-0039): `codex` on the PATH, at the version whose app-server protocol the adapter's
// types were generated from, or newer. The app's copy is Codex's build for macOS on Apple silicon, with
// the tools that lie beside its binary.
export const codexInstall: InstallSpec = {
  provider: 'codex',
  command: 'codex',
  oldest: '0.171.0',
  // As in `codex-cli 0.171.0`.
  version: (output) => /codex-cli (\d+\.\d+\.\d+\S*)/.exec(output)?.[1] ?? null,
  pin,
};
