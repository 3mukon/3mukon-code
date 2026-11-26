---
id: DOC-mod-accounts
type: doc
title: accounts module
status: current
visibility: public
date: 2026-11-04
summary: Each provider's sign-in and a subscription's usage limits, read through the adapters from the calls each provider offers, asked of the providers rarely and kept in the app's own data, with where each provider runs from, the Accounts panel, Codex's reset of its limits and the session pages' notice and sign-in prompt
scope: ["src/accounts/**"]
tags: []
---

## Responsibilities

- The contract (`shared/accounts.ts`): `SignIn`, signed in with a subscription, an API key or another backend, signed out, or unknown; `UsageWindow`, a window of a plan's limits with its span, the models it holds alone, its use in percent, or none where the provider gives its reset but not its use, and its reset; `Usage`, a subscription's windows with the resets the provider holds and when they were read; `UsageProblem`, why the usage could not be read, the sign-in refused, the provider unreachable, its answer unreadable, or none offered to programs at all, as Antigravity offers none, and `problemOf`, which reads a failed request as one or the other; `ProviderAccount` and `AccountsList`, what the app holds of each provider, with the last read's problem until a read or a turn gives the usage, and the installs module's view of where it runs from (ADR-0039); `ResetOutcome`; `mostUsed`, the window most used from 80% (`NEARLY_USED`); and `AccountsBridge`, what the window asks through the preload bridge: the accounts and their changes, saying whether it shows the Accounts panel, running a provider's sign-in in a terminal, and spending a reset.
- The adapters' interface (`main/source.ts`): `AccountSource`, which each provider adapter implements beside the sessions interface (ADR-0017): reading the sign-in, with a subscription's usage when asked, giving the provider's sign-in command, hearing what turns report, `AccountNews`, and, where the provider offers it, spending a reset; and `Program`.
- Where the providers run from (ADR-0039): `Accounts` takes each provider's install from the app module, holds its view, and passes on each change, such as a download's progress. It reads every view anew as a window shows the Accounts panel, and with each read of the account. A provider that is not installed is not asked of its account, and its sign-in stays unknown; such a read does not count as one, so that a read after the user installs it asks it at once, as when a window shows the Accounts panel.
- The accounts (`main/accounts.ts`): `Accounts` asks the providers rarely (ADR-0017): every provider once, one at a time, when the app module says the window has opened; a provider's usage when a window shows the Accounts panel and what it holds is five minutes old, every five minutes while one does, and after a reset; its sign-in, with the usage, when a sign-in command ends, and after a turn fails for want of one, once a minute at most. A read under way answers another. The windows turns report replace those of the same span and models without a request. A read that fails leaves what the app holds, saying the provider could not be asked; a provider no longer signed in with a subscription loses its usage. `usageStorage` keeps the usage in `accounts.json` in the app's data, readable by the user alone, leaving out an entry of another shape; the sign-in is read anew in each run. `windowAccountsUi` (`main/native.ts`) asks before a reset is spent, Cancel by default, as the window draws the question (ADR-0013).
- The panel (`renderer/accounts-panel.tsx`): `AccountsPanel` lists each provider with its sign-in, or that it is not installed or being checked, right after its name as a setting's items say their state (`StateLabel`), signed in in the run colour and the rest quietly, Sign In at the row's end while it is not signed in or not installed and no download goes on, and what runs for it (`renderer/install-lines.tsx`): the user's CLI or the app's copy with its version, a CLI of the user's the app passed over and why, an update the next sign-in or session downloads, a download's bar and progress, in percent or in megabytes, and why the last download failed; and for a subscription its windows, each with a bar, its share used and its reset in local time and the window's language, the bar in the wait colour from 80% and the deletion colour once used up, or dashed where the provider gives no share, the share and reset beside the bar or, in a narrow panel, on a line of their own below it, with when they were read and, where a later read could not read them anew, why; with nothing read, a dashed bar and why the usage could not be read; for Codex its resets with Reset Limits and what the reset did. It tells the main process while it shows. `AccountsButton` is the title bar's gauge that opens it.
- The session pages' notes (`renderer/session-notes.tsx`): `UsageNotice`, the window most used from 80%, or reached, with its reset, beside the context in use, which opens the Accounts panel and never asks a provider; `SignInPrompt`, saying that a provider is not signed in, or not installed, with Sign In, or a download's progress while one goes on, and why the last download failed.
- The hooks and formats (`renderer/use-accounts.ts`, `renderer/use-now.ts`, `renderer/format.ts`): `useAccounts` keeps the accounts current through the bridge; `useNow` keeps the time for times shown relative to it; `windowName`, `share`, `resetTime` and `readWhen` say a window's name, a share, a reset time and how long ago a read was.

## Not responsible for

- The providers' calls themselves, which each adapter alone knows (src/providers/), and which the app module hands this module.
- Signing in: the provider's own command runs in a terminal of the terminal module, which the app module opens, from the binary the adapter takes from the installs module, which downloads the app's copy first where needed; signing out, the account's email, billing and purchases stay out.
- Choosing, downloading and keeping the providers' binaries: the installs module (src/installs/).
- Where the panel and the notes show: the app module opens the panel in the panels module and gives the session pages the notes through the sessions module's `AccountViews`.

## Interface

- For the app module: `Accounts`, `usageStorage` and `AccountsUi` from `main/accounts.ts`; `windowAccountsUi` from `main/native.ts`; `AccountsPanel`, `AccountsButton`, `UsageNotice`, `SignInPrompt` and `useAccounts` from `renderer/`; the contract in `shared/accounts.ts`, which the preload bridge also uses.
- For the provider adapters: `AccountSource`, `AccountRead`, `AccountNews` and `Program` from `main/source.ts`, and the types in `shared/accounts.ts`.

## Dependencies

- Uses the sessions module's model (`ProviderId` from `src/sessions/shared/`), the installs module's interface and model (`src/installs/main/install.ts` and `src/installs/shared/`), the ui and i18n modules, React and react-i18next, electron-store and zod in `main/`. The rule `accounts-only-to-sessions-model-ui-and-i18n` in `.dependency-cruiser.js` enforces it.
- The app module imports it, and the provider adapters import only `main/source.ts` and `shared/`.

## Invariants

- The kept usage holds no credential and nothing of the account but its limits and their reset times (ADR-0017), and the app never shows the account's email (invariant 9).
- No request is made on a timer while no window shows the Accounts panel.
- The accounts, the formats and the panel have unit tests (`main/accounts.test.ts`, `renderer/format.test.ts`, `renderer/accounts-panel.test.tsx`, `renderer/session-notes.test.tsx`), and a smoke test opens the panel in the built app with each provider reading settings that sign it in to nothing, and finds Claude Code and Codex not signed in there and on a session page (`tests/smoke/accounts.spec.ts`).
