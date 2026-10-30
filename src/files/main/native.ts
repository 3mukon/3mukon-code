import { dialog, type BrowserWindow } from 'electron';
import type { Translate } from '../../i18n/main/i18n';
import type { CloseAnswer } from '../shared/files';

// The question the files module asks in the main process.
export interface FilesUi {
  // Whether to save a file's changes before its panel closes.
  confirmClose(name: string): Promise<CloseAnswer>;
}

// The question as a sheet on the window that asked, in the main process's language (DOC-mod-i18n),
// with its buttons in macOS's order: Save, the default, then Cancel, which Escape picks, and Don't
// Save apart from them.
export function nativeFilesUi(window: BrowserWindow, t: Translate): FilesUi {
  return {
    confirmClose: async (name) => {
      const { response } = await dialog.showMessageBox(window, {
        type: 'warning',
        message: t('files.close.message', { name }),
        detail: t('files.close.detail'),
        buttons: [t('files.close.save'), t('files.close.cancel'), t('files.close.discard')],
        defaultId: 0,
        cancelId: 1,
      });
      return response === 0 ? 'save' : response === 2 ? 'discard' : 'cancel';
    },
  };
}

// Keeps a window whose editors hold unsaved changes, which its page marks by holding back its unload,
// until the user agrees to lose them: when the window closes, the app quits or the page loads again.
// Cancel is the default answer.
export function keepUnsavedChanges(window: BrowserWindow, t: Translate): void {
  window.webContents.on('will-prevent-unload', (event) => {
    const response = dialog.showMessageBoxSync(window, {
      type: 'warning',
      message: t('files.leave.message'),
      detail: t('files.leave.detail'),
      buttons: [t('files.leave.cancel'), t('files.leave.discard')],
      defaultId: 0,
      cancelId: 0,
    });
    if (response === 1) event.preventDefault();
  });
}
