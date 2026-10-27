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
| [DOC-mod-claude-code](../src/providers/claude-code/README.md) | current | claude-code provider module | The Claude Code adapter, which drives Claude Code through the Claude Agent SDK on the user's own Claude Code sign-in and maps it onto the provider-neutral session model |
| [DOC-mod-codex](../src/providers/codex/README.md) | current | codex provider module | The Codex adapter, which drives Codex through its app-server on the user's own Codex sign-in and maps it onto the provider-neutral session model |
| [DOC-mod-grok-build](../src/providers/grok-build/README.md) | current | grok-build provider module | The Grok Build adapter, which drives Grok Build through its ACP agent mode on the user's own Grok sign-in and maps it onto the provider-neutral session model |
| [DOC-mod-i18n](../src/i18n/README.md) | current | i18n module | The English and Simplified Chinese catalogs and the runtime that shows the UI in the first of them that macOS's preferred languages name |
| [DOC-mod-sessions](../src/sessions/README.md) | current | sessions module | The provider-neutral session model, made of the interface every provider adapter implements, the events and requests a session produces, and the state the UI folds from them |
| [DOC-mod-toolset](../src/toolset/README.md) | current | toolset module | The app's own MCP toolset, 3mukon-code, which the main process serves over local streamable HTTP to each session's provider process with a credential of its own, and whose one tool asks the user questions |
| [DOC-mod-ui](../src/ui/README.md) | current | ui module | The reference design's tokens, as a dark and a matching light theme that follow macOS, and the presentational components and icons other modules build their UI from |

## Architecture decisions

| ID | Status | Title | Summary |
|---|---|---|---|
| [ADR-0002](adr/ADR-0002-desktop-app-stack.md) | accepted | Build the desktop app with Electron and TypeScript | Electron with TypeScript, because it keeps every provider integration, the Claude Agent SDK included, in one process and one language and reuses the most code; a SwiftUI app with a TypeScript provider process, an all-Swift app and Tauri were rejected |
| [ADR-0003](adr/ADR-0003-provider-protocols.md) | accepted | Drive Codex through app-server and Grok Build through ACP agent mode | Codex runs as `codex app-server` and Grok Build as `grok agent stdio`, because only these interfaces let the app answer approvals and questions while a turn runs; the Codex SDK, `codex exec`, `codex mcp-server`, Grok Build's headless mode and third-party ACP adapters were rejected |
| [ADR-0004](adr/ADR-0004-tooling-and-libraries.md) | accepted | Build on Electron 44 and TypeScript 6 with electron-vite, React, Tailwind and i18next | The app uses Electron 44, TypeScript 6, pnpm 12, electron-vite on Vite 8, electron-builder for macOS arm64, React with zustand, Tailwind, i18next, vitest and Playwright, ESLint and Prettier, and dependency-cruiser, with the provider packages pinned and bundled |
| [ADR-0005](adr/ADR-0005-provider-neutral-session-model.md) | accepted | Model every session as one provider-neutral event stream | Each provider adapter maps its protocol onto one internal interface, a session that reports serializable events and takes answers to approvals and questions, using ACP's tool vocabulary, unified diffs and per-request approval options; adopting ACP itself as the internal model and building a UI per provider were rejected |
| [ADR-0006](adr/ADR-0006-two-permission-modes.md) | accepted | Offer two permission modes, automatic approval by default and yolo | Every provider runs in one of two modes, auto, in which the provider's own automatic review approves or denies each action and asks the user only when it cannot decide, and which new sessions start in, or yolo, in which nothing is asked; asking before every action and the providers' other modes are not offered |
| [ADR-0007](adr/ADR-0007-icons-from-lucide.md) | accepted | Take the app's icons from Lucide, through the ui module | The UI takes its icons from Lucide (`lucide-react`, ISC licence), which the ui module re-exports as decorative components so that no other module imports the set directly; hand-drawn icons and SF Symbols were rejected |
| [ADR-0008](adr/ADR-0008-codex-gateway-tokens.md) | accepted | Pass a Codex gateway file's settings to Codex, token included | Provider credentials stay in the providers' own settings and the app never stores, logs or shows a key or token, with one exception to reading and passing them: the main process reads a selected Codex gateway file and passes its settings to Codex, including a token the file holds; refusing such files and letting Codex read them as profiles were rejected |
| [ADR-0009](adr/ADR-0009-mcp-toolset-over-local-http.md) | accepted | Serve the app's MCP toolset from the main process over local streamable HTTP, with a credential per session | The app serves its own MCP toolset, 3mukon-code, from the main process with the official MCP TypeScript SDK in its stateless streamable HTTP mode, on the loopback interface, where each session's provider process authenticates with a random credential of its own; a stdio relay, a hand-written endpoint, Codex's own question tool and Codex's experimental dynamic tools were rejected |
| [ADR-0001](adr/ADR-0001-credentials-stay-in-provider-settings.md) | superseded | Keep provider credentials and gateway tokens in the providers' own settings | The app and its remote host components never hold provider API keys or gateway tokens; gateways are configured in each provider's own settings, rather than stored in the Keychain or dropped |

## Lessons

| ID | Status | Level | Title | Summary |
|---|---|---|---|---|
