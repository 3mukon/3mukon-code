import type { ClientConnection } from '@agentclientprotocol/sdk';
import type { AccountRead } from '../../../accounts/main/source';
import type { SignIn } from '../../../accounts/shared/accounts';
import { record } from './translate';

// ACP's error for a request that needs a sign-in, with which `agy acp` answers session requests while
// it holds none.
const AUTH_REQUIRED = -32000;

// The sign-in that Antigravity's terminal command, `agy acp --login`, stores. `authenticate` with it
// takes that sign-in up again and answers with the account's tier where it has one.
export const TERMINAL_LOGIN = 'terminal-login';

// The account through an Antigravity process (ADR-0017): signed out where it refuses to list the
// sessions for want of a sign-in, and otherwise signed in, with a subscription where `authenticate`
// reports a tier (`_meta.antigravity.tier`), else through another backend, such as a key or a cloud
// project configured in Antigravity's own settings. Antigravity offers no program its usage limits, so
// a subscription's are unavailable.
export async function readAntigravityAccount(
  connection: ClientConnection,
  withUsage: boolean,
): Promise<AccountRead> {
  try {
    await connection.agent.request('session/list', {});
  } catch (error) {
    if (isSignInError(error)) return { signIn: { state: 'signed-out' } };
    throw error;
  }
  const subscribed = await hasTier(connection);
  const signIn: SignIn = { state: 'signed-in', method: subscribed ? 'subscription' : 'backend' };
  return withUsage && subscribed ? { signIn, usageProblem: 'unoffered' } : { signIn };
}

async function hasTier(connection: ClientConnection): Promise<boolean> {
  try {
    const answer = await connection.agent.request('authenticate', { methodId: TERMINAL_LOGIN });
    return record(record(record(answer._meta)?.antigravity)?.tier) !== undefined;
  } catch {
    return false;
  }
}

// Whether a request failed for want of a sign-in: ACP's error code, which JSON-RPC leaves to servers'
// other errors too, with Antigravity's words for it.
export function isSignInError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === AUTH_REQUIRED &&
    'message' in error &&
    /authenticat/i.test(String(error.message))
  );
}
