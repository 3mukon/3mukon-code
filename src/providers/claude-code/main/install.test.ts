import { expect, it } from 'vitest';
import { compareVersions } from '../../../installs/shared/version';
import { claudeCodeInstall } from './install';

it('reads Claude Code’s version, and drives none older than the one its copy is pinned at', () => {
  expect(claudeCodeInstall.version('2.1.330 (Claude Code)\n\n')).toBe('2.1.330');
  expect(claudeCodeInstall.version('claude 2.1.330')).toBeNull();
  expect(
    compareVersions(claudeCodeInstall.oldest, claudeCodeInstall.pin.version),
  ).toBeLessThanOrEqual(0);
});
