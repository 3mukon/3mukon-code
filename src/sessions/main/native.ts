import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, clipboard, ClipboardItem, dialog, type BrowserWindow } from 'electron';
import type { Translate } from '../../i18n/main/i18n';
import type { Prompts } from '../../ui/shared/prompts';
import type { MessageImage, ProviderId } from '../shared/events';
import { imageExtension } from '../shared/images';
import { takesSandboxLevel } from '../shared/levels';
import type { ImageAction, SessionAction, SessionSummary } from '../shared/sessions';
import type { SessionsMenuUi } from './host';

// What the sessions ask the user before a session runs in yolo, where nothing is asked (ADR-0006), and
// what the timeline offers for an image; and a session's menu, with what it asks before archiving a
// session that is working or removing one.
export interface SessionsUi extends SessionsMenuUi {
  // The provider's words where it has one setting of its own (ADR-0043).
  confirmYolo(provider?: ProviderId): Promise<boolean>;
  // Copy Image and Save Image As… in a menu at the pointer; resolves with the choice, or null.
  imageMenu(): Promise<ImageAction | null>;
  // Saves the image where the user chooses in a sheet, Downloads at first; resolves with whether they
  // chose a place.
  saveImage(image: MessageImage): Promise<boolean>;
}

// The questions and the menus at the pointer as the window that asked draws them, in the app's own
// look (the prompts), and in the main process's language (DOC-mod-i18n); the save panel is macOS's
// own, as a sheet on that window. Cancel is the default answer, so that Return never switches to
// yolo, stops a session or removes one by accident.
export function windowSessionsUi(
  window: BrowserWindow,
  prompts: Prompts,
  t: Translate,
): SessionsUi {
  const confirm = async (message: string, detail: string, confirmation: string) =>
    (await prompts.ask({
      message,
      detail,
      answers: [
        { id: 'confirm', label: confirmation },
        { id: 'cancel', label: t('sessions.confirm.cancel') },
      ],
      defaultId: 'cancel',
      cancelId: 'cancel',
    })) === 'confirm';
  // A session by its title, or else by its provider's name, as the lists show it.
  const named = (session: SessionSummary) =>
    session.title === undefined || session.title === ''
      ? t(`providers.${session.provider}`)
      : session.title;
  return {
    confirmYolo: (provider) =>
      confirm(
        t('sessions.yolo.message'),
        provider === undefined || takesSandboxLevel(provider)
          ? t('sessions.yolo.detail')
          : t('sessions.yolo.ownDetail', { provider: t(`providers.${provider}`) }),
        t('sessions.yolo.confirm'),
      ),
    sessionMenu: async (session) =>
      oneOf<SessionAction>(
        await prompts.menu([
          session.archived === true
            ? { id: 'unarchive', label: t('sessions.menu.unarchive') }
            : { id: 'archive', label: t('sessions.menu.archive') },
          { separator: true },
          { id: 'remove', label: t('sessions.menu.remove') },
        ]),
        ['archive', 'unarchive', 'remove'],
      ),
    confirmArchive: (session) =>
      confirm(
        t('sessions.archive.message', { title: named(session) }),
        t('sessions.archive.detail'),
        t('sessions.archive.confirm'),
      ),
    confirmRemove: (session) =>
      confirm(
        t('sessions.remove.message', { title: named(session) }),
        t('sessions.remove.detail', { provider: t(`providers.${session.provider}`) }),
        t('sessions.remove.confirm'),
      ),
    imageMenu: async () =>
      oneOf<ImageAction>(
        await prompts.menu([
          { id: 'copy', label: t('sessions.image.copy') },
          { id: 'save', label: t('sessions.image.save') },
        ]),
        ['copy', 'save'],
      ),
    saveImage: async (image) => {
      const name = `${t('sessions.image.fileName')}.${imageExtension(image.mediaType)}`;
      const { canceled, filePath } = await dialog.showSaveDialog(window, {
        defaultPath: join(app.getPath('downloads'), name),
      });
      if (canceled) return false;
      await writeFile(filePath, Buffer.from(image.data, 'base64'));
      return true;
    },
  };
}

// The menu's choice, where it is one of these, or else null.
function oneOf<Choice extends string>(
  chosen: string | null,
  choices: readonly Choice[],
): Choice | null {
  return choices.find((choice) => choice === chosen) ?? null;
}

export function copyText(text: string): Promise<void> {
  return clipboard.writeText(text);
}

// Puts a PNG image on the clipboard, the image type every app takes from it.
export function copyImage(image: MessageImage): Promise<void> {
  const png = new Blob([Buffer.from(image.data, 'base64')], { type: 'image/png' });
  return clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
