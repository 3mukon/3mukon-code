import { expect, it } from 'vitest';
import { compareVersions } from '../../../installs/shared/version';
import { antigravityInstall } from './install';

it('reads Antigravity’s version, and drives none older than the one its copy is pinned at', () => {
  expect(antigravityInstall.version('1.5.18\n')).toBe('1.5.18');
  expect(antigravityInstall.version('Antigravity CLI')).toBeNull();
  expect(antigravityInstall.pin).toMatchObject({ folder: '', binary: 'antigravity' });
  expect(
    compareVersions(antigravityInstall.oldest, antigravityInstall.pin.version),
  ).toBeLessThanOrEqual(0);
});
