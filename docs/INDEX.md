# Index

Read this first and open documents based on their summaries. One line per document; terminal documents go at the end of their section; rows may be added or removed, columns never. When creating a document or changing its status, title or summary, update this file in the same change.

## Foundation

| ID | Status | Title | Summary |
|---|---|---|---|
| [DOC-architecture](architecture.md) | current | 3mukon-code hard base | Publishable code and docs for a macOS-only desktop app that drives coding agents, sliced into feature modules and bound by nine invariants, protected files and change rules |
| [DOC-conventions](conventions.md) | current | 3mukon-code conventions | Document rules, tags, naming, commit format, checks, agent tools and exemplars |
| [DOC-glossary](glossary.md) | current | Glossary | This project's terms and the synonyms to avoid |

## Current-state docs

| ID | Status | Title | Summary |
|---|---|---|---|

## Modules

| ID | Status | Title | Summary |
|---|---|---|---|
| [DOC-mod-app](../src/app/README.md) | current | app module | The Electron entry point, which starts the desktop app, opens its main window on the app's own page and lays out the window shell |
| [DOC-mod-i18n](../src/i18n/README.md) | current | i18n module | The English and Simplified Chinese catalogs and the runtime that shows the UI in the first of them that macOS's preferred languages name |
| [DOC-mod-ui](../src/ui/README.md) | current | ui module | The reference design's tokens, as a dark and a matching light theme that follow macOS, and the presentational components other modules build their UI from |

## Architecture decisions

| ID | Status | Title | Summary |
|---|---|---|---|
| [ADR-0001](adr/ADR-0001-credentials-stay-in-provider-settings.md) | accepted | Keep provider credentials and gateway tokens in the providers' own settings | The app and its remote host components never hold provider API keys or gateway tokens; gateways are configured in each provider's own settings, rather than stored in the Keychain or dropped |
| [ADR-0002](adr/ADR-0002-desktop-app-stack.md) | accepted | Build the desktop app with Electron and TypeScript | Electron with TypeScript, because it keeps every provider integration, the Claude Agent SDK included, in one process and one language and reuses the most code; a SwiftUI app with a TypeScript provider process, an all-Swift app and Tauri were rejected |
| [ADR-0003](adr/ADR-0003-provider-protocols.md) | accepted | Drive Codex through app-server and Grok Build through ACP agent mode | Codex runs as `codex app-server` and Grok Build as `grok agent stdio`, because only these interfaces let the app answer approvals and questions while a turn runs; the Codex SDK, `codex exec`, `codex mcp-server`, Grok Build's headless mode and third-party ACP adapters were rejected |
| [ADR-0004](adr/ADR-0004-tooling-and-libraries.md) | accepted | Build on Electron 44 and TypeScript 6 with electron-vite, React, Tailwind and i18next | The app uses Electron 44, TypeScript 6, pnpm 12, electron-vite on Vite 8, electron-builder for macOS arm64, React with zustand, Tailwind, i18next, vitest and Playwright, ESLint and Prettier, and dependency-cruiser, with the provider packages pinned and bundled |

## Lessons

| ID | Status | Level | Title | Summary |
|---|---|---|---|---|
