import { useEffect, useSyncExternalStore } from 'react';
import type { ModelOption, ProviderId } from '../shared/events';
import { choiceIn, withChoice } from '../shared/folders';
import type { FolderChoices, RememberedChoice, SessionsBridge } from '../shared/sessions';

// What session pages offer to choose from: the providers, each provider's gateways, and the models
// of each provider through each gateway, without a folder and in each folder a new page opens in,
// keyed as `modelsKey` gives them; and the settings sessions last used, each folder's and the day
// folders', which a page in the folder starts with. Missing until it comes; a list that could not be
// found is empty.
interface Lists {
  providers?: ProviderId[];
  gateways: Partial<Record<ProviderId, string[]>>;
  // A failed initial listing stays distinct from a successful empty catalog, so a fallback that
  // finishes later can still be shown.
  models: Partial<Record<string, ModelOption[] | null>>;
  remembered?: FolderChoices;
}

const NONE: string[] = [];
const NO_MODELS: ModelOption[] = [];

function modelsKey(provider: ProviderId, gateway: string | null, folder: string | null): string {
  return `${provider}\n${gateway ?? ''}\n${folder ?? ''}`;
}

// The models a page in the folder shows: those found there, or else, until they come, those found
// without a folder.
function shownModels(
  lists: Lists,
  provider: ProviderId,
  gateway: string | null,
  folder: string | null,
): ModelOption[] | undefined {
  const own = lists.models[modelsKey(provider, gateway, folder)];
  const fallback = folder === null ? undefined : lists.models[modelsKey(provider, gateway, null)];
  return own ?? fallback ?? (own === null || fallback === null ? NO_MODELS : undefined);
}

// The lists one window's session pages share, so that a page opened after they came has them as it
// first shows. Once the providers are known, each one's gateways and the models of its own
// configuration, without a folder, are asked for, whichever provider a page shows. The providers and
// a found list of models are kept, as the main process keeps them; a page before its first message
// asks for the models in its folder fresh as it opens, since the provider's settings may have changed,
// and shows the list kept for its folder, or else the one without a folder, until they come. Gateways are asked
// for again whenever a page needs them, since the user may add one at any time; a list that failed is
// asked for again when a page needs it, and leaves a list already shown as it was. Each list is asked
// for once at a time.
class Offers {
  private lists: Lists = { gateways: {}, models: {} };
  private readonly listeners = new Set<() => void>();
  private readonly asking = new Set<string>();
  private readonly kept = new Set<string>();

  constructor(private readonly bridge: SessionsBridge) {}

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly current = (): Lists => this.lists;

  loadProviders(): void {
    this.ask(
      'providers',
      true,
      () => this.bridge.providers(),
      (lists, providers) => ({ ...lists, providers }),
      [],
      (providers) => {
        for (const provider of providers) {
          this.loadGateways(provider);
          this.loadModels(provider, null, null, false);
        }
      },
    );
  }

  loadGateways(provider: ProviderId): void {
    this.ask(
      `gateways\n${provider}`,
      false,
      () => this.bridge.gateways(provider),
      (lists, gateways) => ({ ...lists, gateways: { ...lists.gateways, [provider]: gateways } }),
      [],
    );
  }

  // Without an answer, pages start with the defaults until one comes.
  loadRemembered(): void {
    this.ask<FolderChoices | undefined>(
      'remembered',
      true,
      () => this.bridge.choices(),
      (lists, remembered) => (remembered === undefined ? lists : { ...lists, remembered }),
      undefined,
    );
  }

  // Keeps the folder's settings, or the day folders' for a day folder, for this window's pages at
  // once, and in the app's data.
  remember(folder: string, choice: RememberedChoice): void {
    this.update((lists) =>
      lists.remembered === undefined
        ? lists
        : { ...lists, remembered: withChoice(lists.remembered, folder, choice) },
    );
    this.bridge.rememberChoice(folder, choice).catch((error: unknown) => {
      console.error('A session’s settings could not be remembered:', error);
    });
  }

  loadModels(
    provider: ProviderId,
    gateway: string | null,
    folder: string | null,
    fresh: boolean,
  ): void {
    const key = modelsKey(provider, gateway, folder);
    const asked = `models\n${key}`;
    if (fresh) this.kept.delete(asked);
    this.ask<ModelOption[] | undefined>(
      asked,
      true,
      () => this.bridge.models(provider, gateway, folder, fresh),
      (lists, models) =>
        models === undefined && shownModels(lists, provider, gateway, folder) !== undefined
          ? lists
          : { ...lists, models: { ...lists.models, [key]: models ?? null } },
      undefined,
    );
  }

  // Asks for a list unless it is being asked for, or kept from an earlier answer; a failed answer
  // leaves the list empty and is not kept.
  private ask<Value>(
    key: string,
    keep: boolean,
    request: () => Promise<Value>,
    store: (lists: Lists, value: Value) => Lists,
    failed: Value,
    then?: (value: Value) => void,
  ): void {
    if (this.asking.has(key) || this.kept.has(key)) return;
    this.asking.add(key);
    request().then(
      (value) => {
        this.asking.delete(key);
        if (keep) this.kept.add(key);
        this.update((lists) => store(lists, value));
        then?.(value);
      },
      (error: unknown) => {
        this.asking.delete(key);
        console.error('A session page’s choices could not be found:', error);
        this.update((lists) => store(lists, failed));
      },
    );
  }

  private update(change: (lists: Lists) => Lists): void {
    this.lists = change(this.lists);
    for (const listener of this.listeners) listener();
  }
}

const offersByBridge = new WeakMap<SessionsBridge, Offers>();

function offersOf(bridge: SessionsBridge): Offers {
  let offers = offersByBridge.get(bridge);
  if (offers === undefined) {
    offers = new Offers(bridge);
    offersByBridge.set(bridge, offers);
  }
  return offers;
}

// Asks ahead of time for what session pages offer, as the window opens, so that a page shows its
// provider's models as soon as it opens.
export function preloadOffers(bridge: SessionsBridge): void {
  const offers = offersOf(bridge);
  offers.loadProviders();
  offers.loadRemembered();
}

// The settings the folder's sessions last used, or the day folders' in a day folder, as a page there
// starts with them, or nothing while there are none. A provider the app no longer offers leaves
// nothing, and a gateway that is gone leaves the provider's own configuration, with its default model
// and the page's starting effort.
export function useRemembered(
  bridge: SessionsBridge,
  folder: string,
): RememberedChoice | undefined {
  const offers = offersOf(bridge);
  const lists = useSyncExternalStore(offers.subscribe, offers.current);
  useEffect(() => {
    offers.loadRemembered();
  }, [offers]);
  const remembered =
    lists.remembered === undefined ? undefined : choiceIn(lists.remembered, folder);
  if (remembered === undefined) return undefined;
  if (lists.providers?.includes(remembered.provider) === false) return undefined;
  const gateways = lists.gateways[remembered.provider];
  if (remembered.gateway !== null && gateways?.includes(remembered.gateway) === false) {
    return { ...remembered, gateway: null, model: null, effort: null };
  }
  return remembered;
}

// Remembers the settings a session in the folder started with or switched to.
export function rememberChoice(
  bridge: SessionsBridge,
  folder: string,
  choice: RememberedChoice,
): void {
  offersOf(bridge).remember(folder, choice);
}

// What a session page offers for its provider and gateway: the providers, the provider's gateways
// and its models through the gateway, in the folder where one is given, each missing until it comes;
// fresh for a page before its first message, which asks for the models anew as it opens.
export function useOffers(
  bridge: SessionsBridge,
  provider: ProviderId,
  gateway: string | null,
  folder: string | null,
  fresh: boolean,
): { providers?: ProviderId[]; gateways: string[]; models?: ModelOption[] } {
  const offers = offersOf(bridge);
  const lists = useSyncExternalStore(offers.subscribe, offers.current);
  useEffect(() => {
    offers.loadProviders();
  }, [offers]);
  useEffect(() => {
    offers.loadGateways(provider);
  }, [offers, provider]);
  useEffect(() => {
    offers.loadModels(provider, gateway, folder, fresh);
  }, [offers, provider, gateway, folder, fresh]);
  const models = shownModels(lists, provider, gateway, folder);
  return {
    ...(lists.providers === undefined ? {} : { providers: lists.providers }),
    gateways: lists.gateways[provider] ?? NONE,
    ...(models === undefined ? {} : { models }),
  };
}
