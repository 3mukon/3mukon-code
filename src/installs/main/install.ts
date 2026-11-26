import type { ProviderId } from '../../sessions/shared/events';
import type { InstallView } from '../shared/installs';

// Where the app's copy of a provider comes from: the provider's official build for macOS on Apple
// silicon, at the version the app's build pins, checked against the checksum it pins (ADR-0039). Each
// adapter's `pin.json` holds one, which `scripts/provider-pins.mjs` writes from the lockfile.
export interface Pin {
  // The version of the CLI that the build is, as its `--version` says it.
  version: string;
  // The build's tarball.
  url: string;
  // The tarball's checksum in the form the lockfile and the npm registry give: `sha512-` and the
  // digest in base64.
  integrity: string;
  // The tarball's folder that the copy is made of, and the binary in it, which the app runs.
  folder: string;
  binary: string;
  // The binary is compressed with brotli, and runs unpacked, without its `.br`.
  brotli?: boolean;
}

// What an adapter says of its provider's CLI.
export interface InstallSpec {
  provider: ProviderId;
  // The CLI's name on the PATH.
  command: string;
  // The oldest version of the CLI the adapter drives (ADR-0039).
  oldest: string;
  // The version in what the CLI prints for `--version`, or null where it names none.
  version: (output: string) => string | null;
  pin: Pin;
}

// The binary a provider's process runs, the user's CLI or the app's own copy, and its version.
export interface Binary {
  path: string;
  version: string;
  source: 'user' | 'app';
}

// A provider's CLI, as its adapter and the accounts ask for it.
export interface ProviderInstall {
  readonly provider: ProviderId;
  // The binary the provider's next process runs, chosen anew each time: the user's CLI where one the
  // adapter drives is on the PATH, or else the app's copy. Rejects with NotInstalledError where there
  // is neither.
  current(): Promise<Binary>;
  // The binary a sign-in or a session runs: as current, but first downloading the pinned copy where
  // the app would run a copy of its own and has none of the pinned version. Where that download fails,
  // a copy of another version the adapter drives runs instead, and with none it rejects.
  prepare(): Promise<Binary>;
  // What Accounts shows of the provider's CLI, read anew.
  view(): Promise<InstallView>;
  // Calls the listener with what Accounts shows as a download goes on and ends, and returns a
  // function that stops it.
  onChange(listener: (view: InstallView) => void): () => void;
}

// Neither a CLI of the user's that the adapter drives nor a copy of the app's.
export class NotInstalledError extends Error {
  constructor(readonly provider: ProviderId) {
    super(
      `${provider} is not installed: the PATH holds no CLI of it that the app drives, and the app has no copy.`,
    );
    this.name = 'NotInstalledError';
  }
}
