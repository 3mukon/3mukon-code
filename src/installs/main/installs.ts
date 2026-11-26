import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderId } from '../../sessions/shared/events';
import type { DownloadProblem, InstallView } from '../shared/installs';
import { Copies } from './copies';
import { DownloadError, downloadBuild, type Fetch, type Progress } from './download';
import { findCommand, Versions } from './find';
import {
  type Binary,
  type InstallSpec,
  NotInstalledError,
  type Pin,
  type ProviderInstall,
} from './install';
import { compareVersions } from '../shared/version';

// How often a download's progress reaches Accounts at most.
const PROGRESS_MS = 250;

export interface InstallsOptions {
  // The folder of the app's copies, `providers` in the app's data folder.
  folder: string;
  // The folders to look in for the user's CLIs, asked each time: those of the PATH the app runs the
  // providers with, or the tests' own (ADR-0039).
  searchFolders(): readonly string[];
  fetch: Fetch;
  // Pins that replace the adapters' own, which only tests give (ADR-0039).
  pins?: Partial<Record<ProviderId, Pin>>;
  versions?: Versions;
  now?: () => number;
}

export interface Installs {
  // The provider's CLI, as the adapter describes it.
  for(spec: InstallSpec): ProviderInstall;
}

// Where each provider's processes come from (ADR-0039): the user's CLI, the app's own copies, and the
// downloads that make them.
export function createInstalls(options: InstallsOptions): Installs {
  const versions = options.versions ?? new Versions();
  return {
    for(spec) {
      const pin = options.pins?.[spec.provider] ?? spec.pin;
      return new Install({ ...spec, pin }, options, versions);
    },
  };
}

type UserCli =
  | { binary: Binary }
  | { passedOver: { path: string; version: string | null; oldest: string } }
  | null;

class Install implements ProviderInstall {
  readonly provider: ProviderId;
  private readonly copies: Copies;
  // The binary's name in a copy: the pin's, without the `.br` of one that comes compressed.
  private readonly binary: string;
  private downloading: Promise<Binary> | null = null;
  private progress: Progress | null = null;
  private failed: DownloadProblem | null = null;
  private readonly listeners = new Set<(view: InstallView) => void>();
  private lastEmit = 0;
  private emitTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly spec: InstallSpec,
    private readonly options: InstallsOptions,
    private readonly versions: Versions,
  ) {
    this.provider = spec.provider;
    this.copies = new Copies(join(options.folder, spec.provider), options.now);
    this.binary = spec.pin.brotli === true ? spec.pin.binary.replace(/\.br$/, '') : spec.pin.binary;
  }

  async current(): Promise<Binary> {
    const user = await this.user();
    if (user !== null && 'binary' in user) {
      void this.copies.removeUnused();
      return user.binary;
    }
    const copy = await this.copy();
    if (copy === null) throw new NotInstalledError(this.provider);
    await this.copies.markRun(copy.version);
    return copy;
  }

  async prepare(): Promise<Binary> {
    const user = await this.user();
    if (user !== null && 'binary' in user) return user.binary;
    const copy = await this.copy();
    if (copy?.version === this.spec.pin.version) {
      await this.copies.markRun(copy.version);
      return copy;
    }
    try {
      return await this.download();
    } catch (error) {
      if (copy === null) throw error;
      console.error(`The app keeps its copy of ${this.provider} ${copy.version}:`, error);
      await this.copies.markRun(copy.version);
      return copy;
    }
  }

  async view(): Promise<InstallView> {
    const user = await this.user();
    const runs = user !== null && 'binary' in user ? user.binary : await this.copy();
    return {
      runs: runs === null ? null : { source: runs.source, version: runs.version },
      ...(user !== null && 'passedOver' in user ? { passedOver: user.passedOver } : {}),
      pinned: this.spec.pin.version,
      ...(this.progress === null ? {} : { downloading: { ...this.progress } }),
      ...(this.failed === null ? {} : { failed: this.failed }),
    };
  }

  onChange(listener: (view: InstallView) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // The user's CLI where it is on the PATH: the binary where the adapter drives its version, or else
  // the CLI the app passes over.
  private async user(): Promise<UserCli> {
    const path = await findCommand(this.spec.command, this.options.searchFolders());
    if (path === null) return null;
    const version = await this.versions.read(path, this.spec.version);
    if (version !== null && compareVersions(version, this.spec.oldest) >= 0) {
      return { binary: { path, version, source: 'user' } };
    }
    return { passedOver: { path, version, oldest: this.spec.oldest } };
  }

  // The app's copy that runs: the pinned version's, or else the newest copy the adapter drives.
  private async copy(): Promise<Binary | null> {
    const pinned = await this.copies.get(this.spec.pin.version, this.binary);
    if (pinned !== null) return { path: pinned, version: this.spec.pin.version, source: 'app' };
    for (const version of await this.copies.versions()) {
      if (compareVersions(version, this.spec.oldest) < 0) break;
      const path = await this.copies.get(version, this.binary);
      if (path !== null) return { path, version, source: 'app' };
    }
    return null;
  }

  // One download of the pinned copy at a time, which every sign-in and session waiting for it shares.
  private download(): Promise<Binary> {
    this.downloading ??= this.downloadOnce().finally(() => {
      this.downloading = null;
      this.progress = null;
      this.emit(true);
    });
    return this.downloading;
  }

  private async downloadOnce(): Promise<Binary> {
    this.failed = null;
    this.progress = { received: 0, total: null };
    this.emit(true);
    let staging: string | undefined;
    try {
      staging = await this.copies.staging();
      const made = await downloadBuild(this.spec.pin, staging, this.options.fetch, (progress) => {
        this.progress = progress;
        this.emit(false);
      });
      const path = await this.copies.commit(made, this.spec.pin.version, this.binary);
      await this.copies.markRun(this.spec.pin.version);
      return { path, version: this.spec.pin.version, source: 'app' };
    } catch (error) {
      this.failed = error instanceof DownloadError ? error.problem : 'folder';
      throw error;
    } finally {
      if (staging !== undefined) await rm(staging, { recursive: true, force: true });
    }
  }

  // Tells the listeners what Accounts shows: at once where asked, and otherwise at most every quarter
  // of a second, the last progress last.
  private emit(now: boolean): void {
    if (this.listeners.size === 0) return;
    const wait = this.lastEmit + PROGRESS_MS - (this.options.now ?? Date.now)();
    if (!now && wait > 0) {
      this.emitTimer ??= setTimeout(() => {
        this.emitTimer = null;
        this.emit(true);
      }, wait);
      return;
    }
    if (this.emitTimer !== null) clearTimeout(this.emitTimer);
    this.emitTimer = null;
    this.lastEmit = (this.options.now ?? Date.now)();
    void this.view().then((view) => {
      for (const listener of this.listeners) listener(view);
    });
  }
}
