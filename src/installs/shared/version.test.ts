import { describe, expect, it } from 'vitest';
import { compareVersions, isVersion } from './version';

describe('versions', () => {
  it('reads the versions the providers’ CLIs and the npm registry write', () => {
    expect(isVersion('2.1.330')).toBe(true);
    expect(isVersion('0.172.0-alpha.3')).toBe(true);
    expect(isVersion('1.0.92+b06756fd6256')).toBe(true);
    expect(isVersion('1.0')).toBe(false);
    expect(isVersion('v1.0.0')).toBe(false);
    expect(isVersion('../1.0.0')).toBe(false);
  });

  it('orders them as semantic versioning does', () => {
    const ordered = [
      '0.9.9',
      '0.171.0-alpha',
      '0.171.0-alpha.2',
      '0.171.0-alpha.10',
      '0.171.0-beta',
      '0.171.0',
      '0.171.1',
      '2.1.330',
      '10.0.0',
    ];
    ordered.reduce((earlier, later) => {
      expect(compareVersions(earlier, later)).toBe(-1);
      expect(compareVersions(later, earlier)).toBe(1);
      return later;
    });
    expect(compareVersions('1.0.92+abc', '1.0.92')).toBe(0);
    expect(() => compareVersions('1.0', '1.0.0')).toThrow('Not a version: 1.0');
  });
});
