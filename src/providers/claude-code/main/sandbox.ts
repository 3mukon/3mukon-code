import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type { SandboxLevel } from '../../../sessions/shared/events';

export type FlagSettings = Parameters<Query['applyFlagSettings']>[0];

// The folders a session's sandbox names, by their real paths, which are what the sandbox matches.
export interface SandboxFolders {
  // The session's folder.
  cwd: string;
  // The user's temporary folder and /tmp.
  temporary: string[];
}

export async function sandboxFolders(cwd: string): Promise<SandboxFolders> {
  const [folder, userTemporary, sharedTemporary] = await Promise.all([
    realPath(cwd),
    realPath(tmpdir()),
    realPath('/tmp'),
  ]);
  return { cwd: folder, temporary: [...new Set([userTemporary, sharedTemporary])] };
}

async function realPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

// The sandbox confines commands; Claude Code's own file-editing tools are kept out by deny rules.
const EDITING_TOOLS = ['Edit', 'Write', 'NotebookEdit'];

// The flag settings that put a running Claude Code on a sandbox level, the same in every permission
// mode. The level owns the flag layer's sandbox settings, over any that a gateway's file sets. Read-only
// also sets the flag layer's permission rules, to deny the file-editing tools, and leaving read-only
// clears them. A sandbox that cannot start stops the session rather than letting commands run without
// one. In workspace-write, a command that cannot run in the sandbox may ask to run outside it, and the
// permission mode decides that request as any other; read-only allows no command outside.
export function sandboxSettings(
  level: SandboxLevel,
  folders: SandboxFolders,
  leavingReadOnly: boolean,
): FlagSettings {
  switch (level) {
    case 'full-access':
      return { sandbox: { enabled: false }, ...(leavingReadOnly ? { permissions: null } : {}) };
    case 'workspace-write':
      return {
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: true,
          filesystem: { allowWrite: [folders.cwd, ...folders.temporary] },
        },
        ...(leavingReadOnly ? { permissions: null } : {}),
      };
    case 'read-only':
      return {
        sandbox: {
          enabled: true,
          failIfUnavailable: true,
          autoAllowBashIfSandboxed: true,
          allowUnsandboxedCommands: false,
          filesystem: { allowWrite: [], denyWrite: [folders.cwd] },
        },
        permissions: { deny: EDITING_TOOLS },
      };
  }
}
