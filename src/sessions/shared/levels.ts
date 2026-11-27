import type { PermissionMode, ProviderId, SandboxLevel } from './events';

// The providers whose sessions take none of the app's sandbox levels, but one setting of their own,
// auto or yolo, which their own modes run (ADR-0043).
const OWN_SETTING: ReadonlySet<ProviderId> = new Set<ProviderId>(['antigravity']);

// The sandbox levels from the narrowest to the widest.
const SANDBOX_ORDER: readonly SandboxLevel[] = ['read-only', 'workspace-write', 'full-access'];

// Whether a provider's sessions take the app's sandbox levels.
export function takesSandboxLevel(provider: ProviderId): boolean {
  return !OWN_SETTING.has(provider);
}

// The level a session counts as wherever the app compares levels: the one it has, or, for a provider
// with one setting of its own, workspace-write in auto and full access in yolo (ADR-0043).
export function countedLevel(
  provider: ProviderId,
  mode: PermissionMode,
  sandbox: SandboxLevel,
): SandboxLevel {
  if (takesSandboxLevel(provider)) return sandbox;
  return mode === 'yolo' ? 'full-access' : 'workspace-write';
}

// Whether one level reaches further than another.
export function wider(level: SandboxLevel, than: SandboxLevel): boolean {
  return SANDBOX_ORDER.indexOf(level) > SANDBOX_ORDER.indexOf(than);
}
