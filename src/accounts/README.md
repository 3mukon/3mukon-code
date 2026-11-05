---
id: DOC-mod-accounts
type: doc
title: accounts module
status: current
visibility: public
date: 2026-11-04
summary: Each provider's sign-in and a subscription's usage limits, read through the adapters from the calls each provider offers, asked of the providers rarely and kept in the app's own data, with the Accounts panel, Codex's reset of its limits and the session pages' notice and sign-in prompt
scope: ["src/accounts/**"]
tags: []
---

## Responsibilities

- The contract (`shared/accounts.ts`): `SignIn`, signed in with a subscription, an API key or another backend, signed out, or unknown; `UsageWindow`, a window of a plan's limits with its span, the models it holds alone, its use in percent, or none where the provider gives its reset but not its use, and its reset; `Usage`, a subscription's windows with the resets the provider holds and when they were read; `UsageProblem`, why the usage could not be read, the sign-in refused, the provider unreachable or its answer unreadable, and `problemOf`, which reads a failed request as one or the other; `ProviderAccount` and `AccountsList`, what the app holds of each provider, with the last read's problem until a read or a turn gives the usage; `ResetOutcome`; `mostUsed`, the window most used from 80% (`NEARLY_USED`); and `AccountsBridge`, what the window asks through the preload bridge: the accounts and their changes, saying whether it shows the Accounts panel, running a provider's sign-in in a terminal, and spending a reset.
- The adapters' interface (`main/source.ts`): `AccountSource`, which each provider adapter implements beside the sessions interface (ADR-0017): reading the sign-in, with a subscription's usage when asked, giving the provider's sign-in command, hearing what turns report, `AccountNews`, and, where the provider offers it, spending a reset; and `Program`.
- The accounts (`main/accounts.ts`): `Accounts` asks the providers rarely (ADR-0017): every provider once, one at a time, when the app module says the window has opened; a provider's usage when a window shows the Accounts panel and what it holds is five minutes old, every five minutes while one does, and after a reset; its sign-in, with the usage, when a sign-in command ends, and after a turn fails for want of one, once a minute at most. A read under way answers another. The windows turns report replace those of the same span and models without a request. A read that fails leaves what the app holds, saying the provider could not be asked; a provider no longer signed in with a subscription loses its usage. `usageStorage` keeps the usage in `accounts.json` in the app's data, readable by the user alone, leaving out an entry of another shape; the sign-in is read anew in each run. `windowAccountsUi` (`main/native.ts`) asks before a reset is spent, Cancel by default, as the window draws the question (ADR-0013).
- The panel (`renderer/accounts-panel.tsx`): `AccountsPanel` lists each provider, its sign-in, Sign In while it is not signed in, and for a subscription its windows, each with a bar, its share used and its reset in local time and the window's language, the bar in the wait colour from 80% and the deletion colour once used up, or dashed where the provider gives no share, the share and reset beside the bar or, in a narrow panel, on a line of their own below it, with when they were read and, where a later read could not read them anew, why; with nothing read, a dashed bar and why the usage could not be read; for Codex its resets with Reset Limits and what the reset did. It tells the main process while it shows. `AccountsButton` is the title bar's gauge that opens it.
- The session pages' notes (`renderer/session-notes.tsx`): `UsageNotice`, the window most used from 80%, or reached, with its reset, beside the context in use, which opens the Accounts panel and never asks a provider; `SignInPrompt`, saying that a provider is not signed in, with Sign In.
- The hooks and formats (`renderer/use-accounts.ts`, `renderer/use-now.ts`, `renderer/format.ts`): `useAccounts` keeps the accounts current through the bridge; `useNow` keeps the time for times shown relative to it; `windowName`, `share`, `resetTime` and `readWhen` say a window's name, a share, a reset time and how long ago a read was.

## Not responsible for

- The providers' calls themselves, which each adapter alone knows (src/providers/), and which the app module hands this module.
- Signing in: the provider's own command runs in a terminal of the terminal module, which the app module opens; signing out, the account's email, billing and purchases stay out.
- Where the panel and the notes show: the app module opens the panel in the panels module and gives the session pages the notes through the sessions module's `AccountViews`.

## Interface

- For the app module: `Accounts`, `usageStorage` and `AccountsUi` from `main/accounts.ts`; `windowAccountsUi` from `main/native.ts`; `AccountsPanel`, `AccountsButton`, `UsageNotice`, `SignInPrompt` and `useAccounts` from `renderer/`; the contract in `shared/accounts.ts`, which the preload bridge also uses.
- For the provider adapters: `AccountSource`, `AccountRead`, `AccountNews` and `Program` from `main/source.ts`, and the types in `shared/accounts.ts`.

## Dependencies

- Uses the sessions module's model (`ProviderId` from `src/sessions/shared/`), the ui and i18n modules, React and react-i18next, electron-store and zod in `main/`. The rule `accounts-only-to-sessions-model-ui-and-i18n` in `.dependency-cruiser.js` enforces it.
- The app module imports it, and the provider adapters import only `main/source.ts` and `shared/`.

## Invariants

- The kept usage holds no credential and nothing of the account but its limits and their reset times (ADR-0017), and the app never shows the account's email (invariant 9).
- No request is made on a timer while no window shows the Accounts panel.
- The accounts, the formats and the panel have unit tests (`main/accounts.test.ts`, `renderer/format.test.ts`, `renderer/accounts-panel.test.tsx`, `renderer/session-notes.test.tsx`), and a smoke test opens the panel in the built app with each provider reading settings that sign it in to nothing, and finds Claude Code and Codex not signed in there and on a session page (`tests/smoke/accounts.spec.ts`).
