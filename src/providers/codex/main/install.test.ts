import { expect, it } from 'vitest';
import { compareVersions } from '../../../installs/shared/version';
import { codexInstall } from './install';

it('reads Codex’s version past its warnings, and drives none older than the one its copy is pinned at', () => {
  const output =
    'codex-cli 0.171.0\n\nWARNING: proceeding, even though we could not create PATH aliases: Refusing to create helper binaries under temporary dir\n';
  expect(codexInstall.version(output)).toBe('0.171.0');
  expect(codexInstall.version('codex 0.171.0')).toBeNull();
  expect(compareVersions(codexInstall.oldest, codexInstall.pin.version)).toBeLessThanOrEqual(0);
});
