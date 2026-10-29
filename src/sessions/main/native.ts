import { dialog, type BrowserWindow } from 'electron';
import type { Translate } from '../../i18n/main/i18n';

// What the sessions ask the user before a session runs in yolo, where nothing is asked (ADR-0006).
export interface SessionsUi {
  confirmYolo(): Promise<boolean>;
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
  };
}
