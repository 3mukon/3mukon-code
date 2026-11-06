import { LOGIN_VARIABLES } from '../login-variables';

// Runs in vitest's process before each live test file. The adapters start the real providers in that
// process's environment, which holds the variables of whatever runs the tests and vitest's own, so the
// process keeps only a login's variables, and each provider starts with those and what its adapter
// adds. The providers then run on the user's own sign-in alone, never with an agent session's base
// URL, account, sockets and tokens when one runs the tests (L-0006).
const login = new Set(LOGIN_VARIABLES);
for (const name of Object.keys(process.env)) {
  if (!login.has(name)) Reflect.deleteProperty(process.env, name);
}
