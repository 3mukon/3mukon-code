import type { InstallSpec } from '../../../installs/main/install';
import pin from './pin.json';

// Antigravity's CLI (ADR-0039): `agy` on the PATH, at the version the adapter's ACP use was written
// against, or newer. The app's copy is Google's build for macOS on Apple silicon, from the versioned
// address and SHA-512 that Google's update manifest gave for it, whose binary, `antigravity`, lies at
// the tarball's root.
export const antigravityInstall: InstallSpec = {
  provider: 'antigravity',
  command: 'agy',
  oldest: '1.5.18',
  // `agy --version` prints the bare version, as in `1.5.18`.
  version: (output) => /^\s*(\d+\.\d+\.\d+\S*)\s*$/m.exec(output)?.[1] ?? null,
  pin,
};
