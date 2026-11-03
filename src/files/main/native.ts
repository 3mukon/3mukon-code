import { dialog, type BrowserWindow } from 'electron';
import type { Translate } from '../../i18n/main/i18n';
import type { Prompts } from '../../ui/shared/prompts';
import type { CloseAnswer } from '../shared/files';

// The question the files module asks in the main process.
export interface FilesUi {
  // Whether to save a file's changes before its panel closes.
  confirmClose(name: string): Promise<CloseAnswer>;
}

// The question as the window that asked draws it, in the app's own look (the prompts), and in the main
// process's language (DOC-mod-i18n), with its answers in macOS's order: Save, the default, then
// Cancel, which Escape picks, and Don't Save apart from them.
export function windowFilesUi(prompts: Prompts, t: Translate): FilesUi {
  return {
    confirmClose: async (name) => {
      const answer = await prompts.ask({
        message: t('files.close.message', { name }),
        detail: t('files.close.detail'),
        answers: [
          { id: 'save', label: t('files.close.save') },
          { id: 'cancel', label: t('files.close.cancel') },
          { id: 'discard', label: t('files.close.discard') },
        ],
        defaultId: 'save',
        cancelId: 'cancel',
      });
      return answer === 'save' || answer === 'discard' ? answer : 'cancel';
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
