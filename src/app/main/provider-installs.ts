import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { app, net } from 'electron';
import { pathFolders } from '../../installs/main/find';
import type { Pin, ProviderInstall } from '../../installs/main/install';
import { createInstalls } from '../../installs/main/installs';
import { claudeCodeInstall } from '../../providers/claude-code/main/install';
import { codexInstall } from '../../providers/codex/main/install';
import { antigravityInstall } from '../../providers/antigravity/main/install';
import { grokBuildInstall } from '../../providers/grok-build/main/install';
import type { ProviderId } from '../../sessions/shared/events';

// Each provider's CLI (ADR-0039): the user's, on the PATH the app runs the providers with, read anew
// for each process, or else the app's own copy in `providers` in its data folder, downloaded through
// Electron's network stack, which follows the system's proxy settings. Only tests replace, at launch,
// the folders the app looks in, with --provider-path, and the pins, with --provider-pins, which names a
// JSON file of pins by provider.
export function providerInstalls(data: string): Record<ProviderId, ProviderInstall> {
  const folders = app.commandLine.getSwitchValue('provider-path');
  const pins = app.commandLine.getSwitchValue('provider-pins');
  const installs = createInstalls({
    folder: join(data, 'providers'),
    searchFolders: () => pathFolders(folders === '' ? process.env.PATH : folders),
    fetch: (url, init) => net.fetch(url, init),
    ...(pins === ''
      ? {}
      : { pins: JSON.parse(readFileSync(pins, 'utf8')) as Partial<Record<ProviderId, Pin>> }),
  });
  // Where earlier builds unpacked Grok Build's binary, which the app's copies replace.
  void rm(join(data, 'grok-build'), { recursive: true, force: true });
  return {
    'claude-code': installs.for(claudeCodeInstall),
    codex: installs.for(codexInstall),
    'grok-build': installs.for(grokBuildInstall),
    antigravity: installs.for(antigravityInstall),
  };
}
