import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existingGatewayPath, gatewayPath, listGateways } from './gateways';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gateways-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('gateways', () => {
  it('lists the JSON files with gateway names, in order, following links to files', async () => {
    writeFileSync(join(dir, 'work.json'), '{}');
    writeFileSync(join(dir, 'Home-2.json'), '{}');
    writeFileSync(join(dir, 'notes.txt'), '');
    writeFileSync(join(dir, '.hidden.json'), '{}');
    writeFileSync(join(dir, 'with space.json'), '{}');
    mkdirSync(join(dir, 'folder.json'));
    symlinkSync(join(dir, 'work.json'), join(dir, 'linked.json'));
    symlinkSync(join(dir, 'missing'), join(dir, 'dangling.json'));
    expect(await listGateways(dir)).toEqual(['Home-2', 'linked', 'work']);
  });

  it('lists none when the folder does not exist', async () => {
    expect(await listGateways(join(dir, 'absent'))).toEqual([]);
  });

  it('refuses names that could lead outside the folder, and gateways that do not exist', async () => {
    expect(gatewayPath(dir, 'work')).toBe(join(dir, 'work.json'));
    expect(() => gatewayPath(dir, '../work')).toThrow('not a gateway name');
    expect(() => gatewayPath(dir, 'a/b')).toThrow('not a gateway name');
    expect(() => gatewayPath(dir, '')).toThrow('not a gateway name');
    await expect(existingGatewayPath(dir, 'work')).rejects.toThrow('does not exist');
  });
});
