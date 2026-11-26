import type { InstallSpec } from '../../../installs/main/install';
import pin from './pin.json';

// Grok Build's CLI (ADR-0039): `grok` on the PATH, at the version the adapter's ACP use was written
// against, or newer. The app's copy is Grok Build's build for macOS on Apple silicon, which comes
// compressed with brotli.
export const grokBuildInstall: InstallSpec = {
  provider: 'grok-build',
  command: 'grok',
  oldest: '1.0.92',
  // As in `grok 1.0.92 (b06756fd6256)`.
  version: (output) => /grok (\d+\.\d+\.\d+\S*)/.exec(output)?.[1] ?? null,
  pin,
};
