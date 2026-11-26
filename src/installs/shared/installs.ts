// Why a download of the app's copy of a provider failed: the address could not be reached or did not
// give the build, the build did not match its checksum, it could not be unpacked, or the app's data
// folder would not take it.
export type DownloadProblem = 'network' | 'checksum' | 'unpack' | 'folder';

// What the app runs for a provider, as Accounts shows it (ADR-0039).
export interface InstallView {
  // What the provider's next process runs: the user's CLI or the app's own copy, at its version; null
  // where neither is, and the provider is not installed.
  runs: { source: 'user' | 'app'; version: string } | null;
  // The user's CLI that the app passed over, where it found one: older than the oldest version the
  // adapter drives, or one whose version it could not read (null).
  passedOver?: { path: string; version: string | null; oldest: string };
  // The version the app's copy is pinned at, which a sign-in or a session downloads where the app
  // runs another copy of its own, or none.
  pinned: string;
  // A download of the app's copy under way: the bytes received, and how many there are where known.
  downloading?: { received: number; total: number | null };
  // Why the last download failed, until one succeeds.
  failed?: DownloadProblem;
}

// The app runs its own copy at another version than the one its build pins, which the next sign-in or
// session downloads.
export function updatePending(view: InstallView): boolean {
  return view.runs?.source === 'app' && view.runs.version !== view.pinned;
}
