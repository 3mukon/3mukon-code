import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, mkdir, unlink } from 'node:fs/promises';
import { createConnection, createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import type { Outcome, ProfileSummary, SetupRequirement } from '../../sessions/shared/automation';
import { CHROME_SETUP_TIMEOUT_MS } from './chrome-local-setup';
import { ChromeNativePeer, type ChromeNativeHandshake } from './chrome-native-peer';
import { ChromePage, type ChromeCommand, type ChromePageDriver } from './chrome-page';
import { refused, type ExternalTab } from './page';

const okay: Outcome<null> = { status: 'verified', value: null };
const profileId = z.string().regex(/^(Default|Profile [1-9][0-9]{0,3})$/);
const savedLink = z.strictObject({
  profile: z.strictObject({ id: profileId, name: z.string().min(1).max(256) }),
  proof: z.string().regex(/^[a-f0-9]{64}$/),
});
const newTab = z.strictObject({ tab: z.int().positive() });
type Link = z.infer<typeof savedLink>;
interface Pairing {
  link: Link;
  ticket: string;
  controller: AbortController;
  extensionFolder?: string;
  peer?: ChromeNativePeer;
  timer?: ReturnType<typeof setTimeout>;
  resolve(outcome: Outcome<null>): void;
}

export interface ChromeProfilePorts {
  // The build of the extension the app carries, the only one it works with.
  build: string;
  profiles(): Promise<ProfileSummary[]>;
  // Installs the host and the extension for Chrome, or renews what is installed of them.
  install(): Promise<void>;
  renew(): Promise<void>;
  openSetup(
    profile: string,
    ticket: string,
    signal: AbortSignal,
    install: (folder: string) => void,
  ): Promise<void>;
  activate(): Promise<void>;
}

// The inherited browser identity lives in Chrome. Each authorized tab is a new
// resource, and the native channel never asks Chrome for the user's tabs.
export class ChromeProfileConnection {
  private readonly server = createServer((socket) => {
    this.accept(socket);
  });
  private readonly socket: string;
  private readonly file: string;
  private readonly peers = new Set<ChromeNativePeer>();
  private readonly listeners = new Set<() => void>();
  private readonly tabEnds = new Set<() => void>();
  private saved?: Link;
  private active?: ChromeNativePeer;
  private pairing?: Pairing;
  private binding?: Promise<void>;
  private readonly renewed: Promise<void>;
  private closed = false;

  constructor(
    private readonly directory: string,
    private readonly ports: ChromeProfilePorts,
  ) {
    this.file = join(directory, 'connection.json');
    this.socket = join(directory, 'channel');
    try {
      this.saved = savedLink.parse(JSON.parse(readFileSync(this.file, 'utf8')));
    } catch {
      // An absent or unreadable link cannot authorize a browser.
    }
    // Before Chrome can connect, so that an extension of an earlier build finds its folder renewed.
    this.renewed = this.ports.renew().catch((error: unknown) => {
      console.error('Chrome’s connector could not be renewed:', error);
    });
    if (this.saved)
      void this.renewed
        .then(() => this.listen())
        .catch(() => {
          this.publish();
        });
  }

  profile(): ProfileSummary | null {
    return this.active ? this.rememberedProfile() : null;
  }

  rememberedProfile(): ProfileSummary | null {
    return this.saved ? { ...this.saved.profile } : null;
  }

  connecting(): boolean {
    return this.pairing !== undefined;
  }

  extensionFolder(): string | undefined {
    return this.pairing?.extensionFolder;
  }

  requirement(): SetupRequirement | undefined {
    if (this.saved || this.pairing) return;
    return { kind: 'browser', browser: 'chrome', step: 'connect' };
  }

  profiles(): Promise<ProfileSummary[]> {
    return this.ports.profiles();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async connect(id: string): Promise<Outcome<null>> {
    if (!profileId.safeParse(id).success) return refused('invalid-request');
    if (!this.canPair()) return refused('busy');
    const profile = (await this.profiles()).find((entry) => entry.id === id);
    if (!profile) return refused('not-found');
    if (!this.canPair()) return refused('busy');

    const result = Promise.withResolvers<Outcome<null>>();
    const pairing: Pairing = {
      link: { profile, proof: randomBytes(32).toString('hex') },
      ticket: randomBytes(32).toString('hex'),
      controller: new AbortController(),
      resolve: result.resolve,
    };
    this.pairing = pairing;
    pairing.timer = setTimeout(() => {
      this.finish(pairing, { status: 'indeterminate', reason: 'timeout', exclusionHeld: false });
    }, CHROME_SETUP_TIMEOUT_MS);
    this.publish();
    try {
      await this.renewed;
      await this.listen();
      if (this.pairing !== pairing) return await result.promise;
      await this.ports.install();
      if (this.pairing !== pairing) return await result.promise;
      await this.ports.openSetup(
        profile.id,
        pairing.ticket,
        pairing.controller.signal,
        (folder) => {
          if (this.pairing !== pairing) return;
          pairing.extensionFolder = folder;
          this.publish();
        },
      );
    } catch {
      this.finish(pairing, refused('connection-lost'));
    }
    return result.promise;
  }

  async disconnect(id: string): Promise<Outcome<null>> {
    if (this.saved?.profile.id !== id) return refused('not-found');
    try {
      rmSync(this.file, { force: true });
    } catch {
      return refused('connection-lost');
    }
    this.saved = undefined;
    const peer = this.active;
    this.active = undefined;
    this.endTabs();
    this.publish();
    if (peer) {
      await peer.request({ kind: 'forget' }).catch(() => undefined);
      peer.close();
    }
    return okay;
  }

  tab(): ExternalTab | null {
    const peer = this.active;
    const profile = this.profile();
    if (!peer || !profile) return null;
    return {
      browser: 'chrome',
      profile,
      page: (events) =>
        ChromePage.connect(new ChromeTaskDriver(peer), events, () => this.ports.activate()),
      onEnd: (listener) => {
        this.tabEnds.add(listener);
        return () => {
          this.tabEnds.delete(listener);
        };
      },
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    if (this.pairing) this.finish(this.pairing, refused('connection-lost'));
    for (const peer of this.peers) peer.close();
    this.server.close();
  }

  private canPair(): boolean {
    return !this.closed && !this.saved && !this.pairing;
  }

  private accept(socket: Socket): void {
    if (this.closed || this.peers.size >= 4) {
      socket.destroy();
      return;
    }
    const peer = new ChromeNativePeer(
      socket,
      (event) => {
        this.handshake(peer, event);
      },
      () => {
        this.peers.delete(peer);
        if (this.active === peer) {
          this.active = undefined;
          this.endTabs();
          this.publish();
        }
        if (this.pairing?.peer === peer) this.finish(this.pairing, refused('connection-lost'));
      },
    );
    this.peers.add(peer);
  }

  private handshake(peer: ChromeNativePeer, event: ChromeNativeHandshake): void {
    // An extension of another build reloads itself from its folder and connects again.
    if (event.kind !== 'pair-saved' && event.build !== this.ports.build) {
      peer.close();
      return;
    }
    const pairing = this.pairing;
    if (event.kind === 'pair' && pairing && !pairing.peer && event.ticket === pairing.ticket) {
      pairing.peer = peer;
      peer.offer(pairing.link.proof);
      return;
    }
    if (event.kind === 'pair-saved' && pairing?.peer === peer && !this.active) {
      const staged = this.file + '.' + randomUUID();
      try {
        writeFileSync(staged, JSON.stringify(pairing.link), { mode: 0o600, flag: 'wx' });
        renameSync(staged, this.file);
      } finally {
        rmSync(staged, { force: true });
      }
      this.saved = pairing.link;
      this.active = peer;
      peer.activate();
      this.finish(pairing, okay);
      return;
    }
    if (
      event.kind === 'restore' &&
      !this.active &&
      this.saved &&
      timingSafeEqual(Buffer.from(event.proof, 'hex'), Buffer.from(this.saved.proof, 'hex'))
    ) {
      this.active = peer;
      peer.activate();
      this.publish();
      return;
    }
    peer.close();
  }

  private finish(pairing: Pairing, result: Outcome<null>): void {
    if (this.pairing !== pairing) return;
    this.pairing = undefined;
    clearTimeout(pairing.timer);
    pairing.controller.abort();
    if (result.status !== 'verified') pairing.peer?.close();
    pairing.resolve(result);
    this.publish();
  }

  private listen(): Promise<void> {
    if (this.server.listening) return Promise.resolve();
    this.binding ??= this.bind().finally(() => {
      this.binding = undefined;
    });
    return this.binding;
  }

  private async bind(): Promise<void> {
    if (Buffer.byteLength(this.socket) >= 104)
      throw new Error('Chrome connection path is too long.');
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const directory = await lstat(this.directory);
    if (!directory.isDirectory() || directory.uid !== process.getuid?.() || directory.mode & 0o077)
      throw new Error('Chrome connection directory is unavailable.');
    await removeStaleSocket(this.socket);
    if (this.closed) throw new Error('Chrome connection closed.');
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.socket, () => {
        this.server.off('error', reject);
        if (this.closed) this.server.close();
        resolve();
      });
    });
  }

  private endTabs(): void {
    for (const end of this.tabEnds) end();
    this.tabEnds.clear();
  }

  private publish(): void {
    for (const listener of this.listeners) listener();
  }
}

// Never remove a live channel if another app instance owns the data directory.
async function removeStaleSocket(path: string): Promise<void> {
  const original = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') throw error;
  });
  if (!original) return;
  if (!original.isSocket() || original.uid !== process.getuid?.())
    throw new Error('Chrome connection socket is unavailable.');
  const stale = await new Promise<boolean>((resolve) => {
    const probe = createConnection(path);
    probe.setTimeout(500);
    probe.once('connect', () => {
      probe.destroy();
      resolve(false);
    });
    probe.once('timeout', () => {
      probe.destroy();
      resolve(false);
    });
    probe.once('error', (error: NodeJS.ErrnoException) => {
      resolve(error.code === 'ECONNREFUSED');
    });
  });
  if (!stale) throw new Error('Chrome connection is already in use.');
  const current = await lstat(path);
  if (original.dev !== current.dev || original.ino !== current.ino)
    throw new Error('Chrome connection changed.');
  await unlink(path);
}

class ChromeTaskDriver implements ChromePageDriver {
  private tab?: number;
  private unwatch?: () => void;
  onPageEvent?: (method: string, value: unknown) => void;

  constructor(private readonly peer: ChromeNativePeer) {}

  async attach(): Promise<void> {
    const { tab } = newTab.parse(await this.peer.request({ kind: 'create-tab' }));
    this.tab = tab;
    this.unwatch = this.peer.watch(tab, (event) => {
      if (event.kind === 'tab-ended') this.onPageEvent?.('app.tab-ended', null);
      if (event.kind === 'tab-event') this.onPageEvent?.(event.method, event.value);
    });
  }

  async detach(): Promise<void> {
    const tab = this.tab;
    this.tab = undefined;
    this.unwatch?.();
    if (tab !== undefined) await this.peer.request({ kind: 'close-tab', tab });
  }

  command(method: ChromeCommand, params: object = {}): Promise<unknown> {
    const tab = this.tab;
    if (tab === undefined) return Promise.reject(new Error('Chrome task tab is unavailable.'));
    return this.peer.request({ kind: 'command', tab, method, params });
  }

  close(): void {
    void this.detach().catch(() => undefined);
  }
}
