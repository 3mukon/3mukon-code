# 3mukon-code

A macOS desktop app for working with coding agents (Claude Code, Codex and Grok Build): start and follow agent sessions, answer their questions and approvals, and review what they changed, all in one place.

This description is a working version.

## Status

The window shell is in place, in English and Simplified Chinese and in light and dark appearance: the title bar, the sidebar and an empty main area. Sessions and providers are not built yet.

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
