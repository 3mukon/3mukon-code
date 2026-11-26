import { expect, it } from 'vitest';
import { compareVersions } from '../../../installs/shared/version';
import { grokBuildInstall } from './install';

it('reads Grok Build’s version, and drives none older than the one its copy is pinned at', () => {
  expect(grokBuildInstall.version('grok 1.0.92 (b06756fd6256)\n')).toBe('1.0.92');
  expect(grokBuildInstall.version('Grok Build')).toBeNull();
  expect(grokBuildInstall.pin.brotli).toBe(true);
  expect(
    compareVersions(grokBuildInstall.oldest, grokBuildInstall.pin.version),
  ).toBeLessThanOrEqual(0);
});
