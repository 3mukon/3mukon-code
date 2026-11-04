import { useEffect, useState } from 'react';
import type { ProviderId } from '../../sessions/shared/events';
import type { AccountsBridge, AccountsList, ProviderAccount } from '../shared/accounts';

export interface Accounts {
  // Empty until the main process answers.
  accounts: ProviderAccount[];
  of(provider: ProviderId): ProviderAccount | undefined;
}

// The providers' accounts as the main process holds them, kept current as they change.
export function useAccounts(bridge: Pick<AccountsBridge, 'list' | 'onChange'>): Accounts {
  const [list, setList] = useState<AccountsList>({ accounts: [] });
  useEffect(() => {
    let current = true;
    const stop = bridge.onChange((changed) => {
      current = false;
      setList(changed);
    });
    bridge.list().then((first) => {
      if (current) setList(first);
    }, report);
    return stop;
  }, [bridge]);
  return {
    accounts: list.accounts,
    of: (provider) => list.accounts.find((account) => account.provider === provider),
  };
}

function report(error: unknown): void {
  console.error('The accounts could not be read:', error);
}
