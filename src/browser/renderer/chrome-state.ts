import type { TFunction } from 'i18next';
import type { SetupSnapshot } from '../../sessions/shared/automation';
import type { StateTone } from '../../ui/renderer/state-label';

export type ChromeSetup = SetupSnapshot['chrome'];

// How Chrome's state reads in Settings and in a session's notice, in the tones Settings' items use:
// connected in the run colour; what the app cannot do for the user, as installing or updating
// Chrome or making its first profile, in the wait colour; a connection the app cannot make, in the
// colour of failure; a wait on Chrome or on its setup, quietly; and nothing while it waits for the
// user to connect it.
export function chromeState(
  chrome: ChromeSetup,
  t: TFunction,
): { state: string; tone: StateTone } | null {
  if (chrome.connection === 'connected')
    return { state: t('browser.chrome.connected'), tone: 'success' };
  if (chrome.installedVersion === null)
    return { state: t('browser.chrome.notInstalled'), tone: 'attention' };
  if (older(chrome.installedVersion, chrome.minimumVersion))
    return {
      state: t('browser.chrome.tooOld', { version: majorOf(chrome.minimumVersion) }),
      tone: 'attention',
    };
  if (chrome.connection === 'waiting') return { state: t('browser.chrome.waiting'), tone: 'muted' };
  if (chrome.connection === 'connecting')
    return { state: t('browser.chrome.connecting'), tone: 'muted' };
  if (chrome.connection === 'unavailable')
    return { state: t('browser.chrome.unavailable'), tone: 'error' };
  if (hasNoProfiles(chrome)) return { state: t('browser.chrome.noProfiles'), tone: 'attention' };
  return null;
}

// Whether a Chrome the app could connect has no profile to connect yet, as before it is first opened.
export function hasNoProfiles(chrome: ChromeSetup): boolean {
  return (
    chrome.connection === 'disconnected' &&
    !chrome.profileAccessRequired &&
    chrome.profiles?.length === 0
  );
}

// What the step that asks for Chrome's folder throws when the user selected another folder.
export class WrongChromeFolder extends Error {}

// The profile a connection uses or waits for, if it has one.
export function chromeProfile(chrome: ChromeSetup) {
  return chrome.profile ?? chrome.rememberedProfile ?? null;
}

// Whether a dotted version comes before another.
function older(version: string, minimum: string): boolean {
  const a = version.split('.').map(Number);
  const b = minimum.split('.').map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const left = a[index] ?? 0;
    const right = b[index] ?? 0;
    if (left !== right) return left < right;
  }
  return false;
}

// The version a user knows a browser by: its first number.
function majorOf(version: string): string {
  return version.split('.')[0] ?? version;
}
