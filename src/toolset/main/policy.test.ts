import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { canonicalScope, checkFiles } from './policy';

it('bounds writes and picks independently of the feature’s existing read permission', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'automation-file-scope-')));
  try {
    const workspace = join(root, 'workspace');
    mkdirSync(workspace);
    const scope = await canonicalScope(workspace, []);
    const path = join(root, 'outside');
    for (const sandbox of ['read-only', 'workspace-write', 'full-access'] as const) {
      expect(
        await checkFiles({ mode: 'auto', sandbox }, scope, [{ path, kind: 'read' }], true),
      ).toEqual({ paths: [path] });
    }
    for (const kind of ['write', 'pick'] as const) {
      expect(
        await checkFiles(
          { mode: 'yolo', sandbox: 'workspace-write' },
          scope,
          [{ path, kind }],
          true,
        ),
      ).toEqual({ code: 'sandbox-denied' });
      expect(
        await checkFiles({ mode: 'yolo', sandbox: 'read-only' }, scope, [{ path, kind }], true),
      ).toEqual({ code: 'sandbox-denied' });
      expect(
        await checkFiles({ mode: 'auto', sandbox: 'full-access' }, scope, [{ path, kind }], true),
      ).toEqual({ paths: [path] });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
