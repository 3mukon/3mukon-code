// The variables a login gives every program, the only ones of a test's own environment that the
// providers it starts may have. That environment holds the variables of whatever runs the tests, and
// the providers inherit it unless a test keeps it from them: Playwright gives the app the whole of it,
// and the app passes its environment on to the providers it starts and to the terminals' shells, while
// a live test's adapter starts its provider in the environment of vitest's own process. Run from an
// agent session, such as Claude Code's, it holds that session's base URL, account, sockets and tokens,
// with which a provider could ask its service as the agent's host (L-0006). Only the names are shared:
// the smoke tests give the app these variables only together with the providers' folders (L-0007),
// and the live tests' setup leaves vitest's process only these.
export const LOGIN_VARIABLES: readonly string[] = [
  'HOME',
  'PATH',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'LANG',
];
