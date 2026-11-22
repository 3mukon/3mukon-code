import type { Outcome, SetupSnapshot } from '../../sessions/shared/automation';

export type HelperPermissions = SetupSnapshot['computer'];
export interface HelperStatus {
  generation: string | null;
  checkedAt: number | null;
  permissions: HelperPermissions;
  connection: 'idle' | 'ready' | 'unavailable' | 'protocol-mismatch';
}

// The Settings / setup host can read cached status without starting a process.
export interface HelperSetup {
  status(): HelperStatus;
  check(): Promise<Outcome<HelperStatus>>;
  restart(): Promise<Outcome<HelperStatus>>;
}
