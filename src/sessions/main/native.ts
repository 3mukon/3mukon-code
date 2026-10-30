import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app, clipboard, ClipboardItem, dialog, Menu, type BrowserWindow } from 'electron';
import type { Translate } from '../../i18n/main/i18n';
import type { MessageImage } from '../shared/events';
import { imageExtension } from '../shared/images';
import type { ImageAction } from '../shared/sessions';

// What the sessions ask the user before a session runs in yolo, where nothing is asked (ADR-0006), and
// what the timeline offers for an image.
export interface SessionsUi {
  confirmYolo(): Promise<boolean>;
  // Copy Image and Save Image As… in a menu at the pointer; resolves with the choice, or null.
  imageMenu(): Promise<ImageAction | null>;
  // Saves the image where the user chooses in a sheet, Downloads at first; resolves with whether they
  // chose a place.
  saveImage(image: MessageImage): Promise<boolean>;
}

// The question as a sheet on the window that asked, in the main process's language (DOC-mod-i18n).
// Cancel is the default answer, so that Return never switches to yolo by accident.
export function nativeSessionsUi(window: BrowserWindow, t: Translate): SessionsUi {
  const confirm = async (message: string, detail: string, confirmation: string) => {
    const { response } = await dialog.showMessageBox(window, {
      type: 'warning',
      message,
      detail,
      buttons: [confirmation, t('sessions.confirm.cancel')],
      defaultId: 1,
      cancelId: 1,
    });
    return response === 0;
  };
  return {
    confirmYolo: () =>
      confirm(t('sessions.yolo.message'), t('sessions.yolo.detail'), t('sessions.yolo.confirm')),
    imageMenu: () =>
      new Promise((resolve) => {
        Menu.buildFromTemplate([
          {
            label: t('sessions.image.copy'),
            click: () => {
              resolve('copy');
            },
          },
          {
            label: t('sessions.image.save'),
            click: () => {
              resolve('save');
            },
          },
          // A menu closed without a choice; a chosen item's click comes first.
        ]).popup({
          window,
          callback: () => {
            setImmediate(() => {
              resolve(null);
            });
          },
        });
      }),
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

export function copyText(text: string): Promise<void> {
  return clipboard.writeText(text);
}

// Puts a PNG image on the clipboard, the image type every app takes from it.
export function copyImage(image: MessageImage): Promise<void> {
  const png = new Blob([Buffer.from(image.data, 'base64')], { type: 'image/png' });
  return clipboard.write([new ClipboardItem({ 'image/png': png })]);
}
