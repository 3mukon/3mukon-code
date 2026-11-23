import type { Outcome, SetupSnapshot } from '../../sessions/shared/automation';

// The helper's name, under which System Settings lists it.
export const HELPER_NAME = 'Computer Use Helper';

export type HelperPermissions = SetupSnapshot['computer'];
export type HelperPermission = 'accessibility' | 'screen-recording' | 'input-monitoring';
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
  // Has macOS ask the user for a permission, after which System Settings lists the helper there, and
  // says whether macOS's prompt, whose button opens System Settings, is in front.
  request(permission: HelperPermission): Promise<Outcome<{ prompted: boolean }>>;
}
