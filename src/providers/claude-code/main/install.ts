import type { InstallSpec } from '../../../installs/main/install';
import pin from './pin.json';

// Claude Code's CLI (ADR-0039): `claude` on the PATH, at the version of Claude Code that the Agent SDK
// in the app brings, its `claudeCodeVersion`, or newer, since the SDK is written against that version.
// The app's copy is that version's binary, which the SDK's package for macOS on Apple silicon carries.
export const claudeCodeInstall: InstallSpec = {
  provider: 'claude-code',
  command: 'claude',
  oldest: '2.1.330',
  // As in `2.1.330 (Claude Code)`.
  version: (output) => /(\d+\.\d+\.\d+\S*) \(Claude Code\)/.exec(output)?.[1] ?? null,
  pin,
};
