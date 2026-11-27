import { describe, expect, it } from 'vitest';
import { countedLevel, takesSandboxLevel, wider } from './levels';

describe('the level a session counts as (ADR-0043)', () => {
  it('is the level itself for a provider that takes the app’s levels', () => {
    expect(takesSandboxLevel('codex-cli')).toBe(true);
    expect(countedLevel('codex-cli', 'yolo', 'read-only')).toBe('read-only');
    expect(countedLevel('claude-code', 'auto', 'full-access')).toBe('full-access');
  });

  it('follows the mode for Antigravity, whatever level was asked for', () => {
    expect(takesSandboxLevel('antigravity')).toBe(false);
    expect(countedLevel('antigravity', 'auto', 'read-only')).toBe('workspace-write');
    expect(countedLevel('antigravity', 'auto', 'full-access')).toBe('workspace-write');
    expect(countedLevel('antigravity', 'yolo', 'read-only')).toBe('full-access');
  });

  it('orders the levels from the narrowest to the widest', () => {
    expect(wider('full-access', 'workspace-write')).toBe(true);
    expect(wider('workspace-write', 'read-only')).toBe(true);
    expect(wider('read-only', 'read-only')).toBe(false);
    expect(wider('workspace-write', 'full-access')).toBe(false);
  });
});
