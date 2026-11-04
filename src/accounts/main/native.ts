import type { Translate } from '../../i18n/main/i18n';
import type { Prompts } from '../../ui/shared/prompts';
import type { AccountsUi } from './accounts';

// The accounts' question for the window that asked, as the window draws it, in the app's own look.
export function windowAccountsUi(prompts: Prompts, t: Translate): AccountsUi {
  return {
    async confirmReset(provider) {
      const answer = await prompts.ask({
        message: t('accounts.confirmReset.message', { provider: t(`providers.${provider}`) }),
        detail: t('accounts.confirmReset.detail'),
        answers: [
          { id: 'reset', label: t('accounts.confirmReset.reset') },
          { id: 'cancel', label: t('accounts.confirmReset.cancel') },
        ],
        defaultId: 'cancel',
        cancelId: 'cancel',
      });
      return answer === 'reset';
    },
  };
}
