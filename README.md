# 3mukon-code

A macOS desktop app for working with coding agents (Claude Code, Codex and Grok Build): start and follow agent sessions, answer their questions and approvals, and review what they changed, all in one place.

This description is a working version.

## Status

The first version is built and awaits its acceptance run. It runs sessions with Claude Code, Codex and Grok Build in the folders of the user's workspaces, follows them live with their approvals and questions answered in place, and resumes and searches them after a restart; its main area arranges sessions, files, terminals and its own panels side by side; it shows each provider's sign-in and usage limits; and it comes in English and Simplified Chinese, in light and dark. [docs/ui.md](docs/ui.md) maps the window, and [docs/providers.md](docs/providers.md) sets the providers side by side.

## Quick start

Requires macOS on Apple silicon and Node.js with Corepack, in the versions `package.json` gives. Install the dependencies:

```bash
corepack pnpm install --frozen-lockfile
```

Run the app in development mode, with hot reload:

```bash
corepack pnpm run dev
```

Build the app and its disk image into `dist/`:

```bash
corepack pnpm run package
```

Build the app and install it into `/Applications`, or into the folder given, in place of an earlier copy, which must not be running:

```bash
sh scripts/install.sh
```

Run every check:

```bash
sh scripts/check.sh
```

## Documentation

Start at [docs/INDEX.md](docs/INDEX.md). The hard base is [docs/architecture.md](docs/architecture.md); agents start at [AGENTS.md](AGENTS.md).

## Licence

3mukon-code is licensed under the [PolyForm Noncommercial License 1.0.0](LICENSE). Commercial use requires a separate licence, negotiated with the maintainer and approved by them in advance.
