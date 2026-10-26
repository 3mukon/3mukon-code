import { mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sandboxFolders, sandboxSettings, type SandboxFolders } from './sandbox';

const folders: SandboxFolders = {
  cwd: '/work',
  temporary: ['/private/var/tmp-user', '/private/tmp'],
};

describe('the sandbox levels', () => {
  it('lets workspace-write write in the session folder and the temporary folders', () => {
    expect(sandboxSettings('workspace-write', folders, false)).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: true,
        filesystem: { allowWrite: ['/work', '/private/var/tmp-user', '/private/tmp'] },
      },
    });
  });

  it('lets read-only write nowhere, deny the editing tools and allow no command outside', () => {
    expect(sandboxSettings('read-only', folders, false)).toEqual({
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        autoAllowBashIfSandboxed: true,
        allowUnsandboxedCommands: false,
        filesystem: { allowWrite: [], denyWrite: ['/work'] },
      },
      permissions: { deny: ['Edit', 'Write', 'NotebookEdit'] },
    });
  });

  it('turns the sandbox off for full access', () => {
    expect(sandboxSettings('full-access', folders, false)).toEqual({ sandbox: { enabled: false } });
  });

  it('clears the deny rules when leaving read-only', () => {
    expect(sandboxSettings('full-access', folders, true)).toMatchObject({ permissions: null });
    expect(sandboxSettings('workspace-write', folders, true)).toMatchObject({ permissions: null });
  });
});

describe('the sandbox folders', () => {
  let root: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'sandbox-folders-')));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('names the session folder and the temporary folders by their real paths', async () => {
    const link = join(root, 'link');
    symlinkSync(root, link);
    const found = await sandboxFolders(link);
    expect(found.cwd).toBe(root);
    expect(found.temporary).toContain(realpathSync('/tmp'));
    expect(found.temporary).toContain(realpathSync(tmpdir()));
  });

  it('keeps a folder that does not exist as given', async () => {
    expect((await sandboxFolders(join(root, 'gone'))).cwd).toBe(join(root, 'gone'));
  });
});
