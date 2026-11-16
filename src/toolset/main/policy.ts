import { lstat, readlink, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  AutomationPolicy,
  FailureCode,
  OperationKind,
  Sharing,
} from '../../sessions/shared/automation';

export type Effect = 'metadata' | 'observe' | 'navigate' | 'mutate' | 'activate' | 'present';
export interface FileIntent {
  path: string;
  kind: 'read' | 'write' | 'pick';
}
export interface FileScope {
  workspace: string;
  temporaryRoots: readonly string[];
}

export function policyFailure(policy: AutomationPolicy, effect: Effect): FailureCode | null {
  return policy.sandbox === 'read-only' && (effect === 'mutate' || effect === 'activate')
    ? 'sandbox-denied'
    : null;
}
export function needsGrant(
  policy: AutomationPolicy,
  kind: OperationKind | null,
  sharing: Sharing | undefined,
): boolean {
  return policy.mode === 'auto' && kind !== null && (kind !== 'browser-tab' || sharing !== 'none');
}

// Existing ancestors are resolved too, so a not-yet-created destination cannot escape through a
// symlink. Executors receive these canonical paths and must constrain their own file mechanisms.
async function canonical(path: string, depth = 0): Promise<string> {
  if (depth > 64) throw new Error('Too many path components.');
  try {
    return await realpath(path);
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    try {
      if ((await lstat(path)).isSymbolicLink())
        return await canonical(resolve(dirname(path), await readlink(path)), depth + 1);
    } catch (missing) {
      if (!(missing instanceof Error) || !('code' in missing) || missing.code !== 'ENOENT')
        throw missing;
    }
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(await canonical(parent, depth + 1), path.slice(parent.length));
  }
}
export async function canonicalScope(
  workspace: string,
  temporaryRoots: readonly string[],
): Promise<FileScope> {
  return {
    workspace: await realpath(workspace),
    temporaryRoots: await Promise.all(temporaryRoots.map((p) => realpath(p))),
  };
}
function inside(root: string, path: string): boolean {
  const part = relative(root, path);
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('../'));
}
export async function checkFiles(
  policy: AutomationPolicy,
  scope: FileScope,
  intents: readonly FileIntent[],
  destinationKnown: boolean,
): Promise<{ paths: string[] } | { code: FailureCode }> {
  if (policy.sandbox !== 'full-access' && !destinationKnown)
    return { code: 'file-scope-unverifiable' };
  if (intents.length > 32) return { code: 'limit-exceeded' };
  const paths: string[] = [];
  for (const intent of intents) {
    if (policy.sandbox === 'read-only' && intent.kind !== 'read') return { code: 'sandbox-denied' };
    if (intent.path.includes('\0') || intent.path.length > 4096)
      return { code: 'file-scope-unverifiable' };
    let path: string;
    try {
      path = await canonical(resolve(scope.workspace, intent.path));
    } catch {
      return { code: 'file-scope-unverifiable' };
    }
    if (
      policy.sandbox === 'workspace-write' &&
      intent.kind !== 'read' &&
      ![scope.workspace, ...scope.temporaryRoots].some((root) => inside(root, path))
    )
      return { code: 'sandbox-denied' };
    paths.push(path);
  }
  return { paths };
}
