---
id: DOC-conventions
type: doc
title: 3mukon-code conventions
status: current
visibility: public
date: 2026-10-23
summary: Document rules, tags, naming, commit format, checks, agent tools and exemplars
scope: []
tags: []
---

This file is the convention tier and may be adjusted to the project's needs: write an ADR when there is a trade-off, otherwise give the reason in the commit message. The Document core section is the exception: it is part of the hard base, and only the maintainer changes it.

## Document core

| Type | ID | Location | Status |
|---|---|---|---|
| doc | `DOC-<slug>`; module READMEs use `DOC-mod-<module>` | Where readers will look | draft / current / superseded / archived |
| adr | `ADR-NNNN` | `docs/adr/` | proposed / accepted / rejected / superseded / deprecated |
| lesson | `L-NNNN` | `docs/lessons/` | active / superseded / obsolete |

- Core fields: id, type, title, status, visibility, date, summary, scope, tags.
- Required sections are marked in each template in `docs/templates/`.

## Documents

- Frontmatter: one field per line, lists written as `[a, b]`; quote values and list items that YAML would misread, for example `scope: ["**/*.go"]`.
- title states the conclusion or the subject; summary is one sentence that answers the question on its own; scope lists globs of the code paths a document concerns, relative to this repository's root; tags uses only tags registered below.
- New number = the highest number among the `id` fields of existing documents of that type + 1, zero-padded to four digits; file names are `<ID>-<slug>.md`; always reference by ID.
- Start from the template for the type in `docs/templates/` (`adr.md`, `lesson.md`, `doc.md`, and `module-readme.md` for module READMEs) and remove its comments; never remove required sections, and if one does not apply, say why.
- Once accepted, an ADR's body never changes; to change the decision, write a new ADR that supersedes it. When a lesson recurs, increment occurrences and move level up at least one rung (doc → rule → comment → test → lint → hook → design).
- When creating a document or changing its status, title or summary, update `docs/INDEX.md` in the same change.
- Authority: code and contracts > current-state docs > accepted ADRs > lessons > historical records; follow superseded_by to the replacement.
- `docs/adr/` and `docs/lessons/` are created with their first document.

## Tags

| Tag | Meaning |
|---|---|

## Naming

- Files and directories: lowercase kebab-case; knowledge documents are `<ID>-<slug>.md`.
- Modules: named for the capability they own (for example `session-history`), never for a layer such as `utils` or `services`.
- Branches: `<type>/<kebab-description>`, where type is one of the commit types below; technical words only.
- Release tags: `v<semver>`, for example `v0.1.0`.

## Commits

```text
<type>: <what changed, in the imperative mood>

<technical reason: why it changed this way; rejected alternatives when relevant>

Refs: ADR-NNNN, L-NNNN
```

type is one of feat, fix, refactor, docs, test, chore. Technical reasons only; `Refs` lists only public IDs. Branch and tag names follow the same rule.

## Checks

| Check | When it runs | What it covers | How to run it by hand |
|---|---|---|---|
| Check command | Before calling work done; CI on every push and pull request | `scripts/checks/docs.sh` (core fields, visibility, INDEX rows), `scripts/guard/test-guards.sh` (guard self-tests), and the invariant 8, invariant 9, catalog and code checks below | `sh scripts/check.sh` |
| Invariant 8 check | Inside the check command | electron-builder is configured in `electron-builder.yml` only, with no target for another platform; `package.json` scripts and `scripts/*.sh` request no other platform; code under `src/` never detects the platform, for example with `process.platform` | `sh scripts/checks/macos-only.sh` |
| Invariant 9 check | Inside the check command | Code under `src/` names no API key or token, as a setting or as an environment variable; matches are reported by file and line only | `sh scripts/checks/no-provider-keys.sh` |
| Catalog parity | Inside the check command | Every folder under `src/` with a UI string catalog holds `en.json` and `zh-Hans.json` with the same keys, plural forms folded, and only non-empty string values | `sh scripts/checks/catalogs.sh` |
| Code checks | Inside the check command, through `scripts/checks/code.sh` | TypeScript (`tsc -b`); ESLint with typescript-eslint's strict type-checked rules and the React hooks rules; the module rules in `.dependency-cruiser.js`; Prettier; vitest unit tests and component tests (in happy-dom), run on Electron's own Node.js; a Playwright smoke test that builds the app, launches it and checks its window | `corepack pnpm run` with `typecheck`, `lint`, `lint:modules`, `format:check`, `test` or `test:smoke` |
| Secret scanning | The maintainer's local hooks: staged changes at commit, outgoing commits at push. CI: full history on every push and pull request | Secrets in content, using gitleaks' default rules | `gitleaks git --redact --no-banner -v .` |
| Publishability check | The maintainer's local hooks, at commit and at push | Private references, local paths and sensitive terms in content, file names, commit messages and pushed ref names | Runs only in the maintainer's hooks |
| Identity check | The maintainer's local hooks, at commit and at push | Every author and committer matches the repository's public commit identity | Runs only in the maintainer's hooks |
| Bypass guard | Agent sessions, before every shell command | Blocks commands that contain `--no-verify`, `-n` on `git commit`, `core.hooksPath` or `.git/hooks`. Matching is plain text, so read-only mentions are blocked too; read those files with the agent's file tools | `sh scripts/guard/test-guards.sh` |
| Protected-path guard | Codex sessions, before every patch | Refuses patches to the protected files listed in `scripts/guard/protected-paths.txt` | `sh scripts/guard/test-guards.sh` |

- Tools: POSIX `sh`, git and the userland of macOS, jq included, for every script; gitleaks 8.30.1 (CI pins it and verifies its checksum; locally `brew install gitleaks`).
- The app's toolchain: Node.js in the range `engines` in `package.json` gives, with its bundled Corepack, which runs the pnpm version `packageManager` pins; commands start with `corepack pnpm`. The code checks need the dependencies installed with `corepack pnpm install --frozen-lockfile` and fail with that instruction otherwise. Packages that electron-vite bundles into the app, React for example, are `devDependencies`; `dependencies` holds only packages the packaged app loads at run time.
- CI runs on GitHub Actions macOS runners, so the scripts are tested on the same userland they are written for. The code host is GitHub. CI and server-side gates are not live until the remote exists.

## Agent tools

- Claude Code: `CLAUDE.md` imports `AGENTS.md`. `.claude/settings.json` asks before protected files are edited, denies reading secret files and runs the bypass guard before every shell command with `onFailure: "block"`, so a missing or failing guard blocks the command; that needs Claude Code 2.1.295 or later. Ask rules cover Claude Code's file tools only, not shell commands that write files.
- Codex: reads `AGENTS.md` natively. `.codex/hooks.json` runs the bypass guard before shell commands and the protected-path guard before patches. Codex hooks cannot ask, so the maintainer applies protected changes themselves. Codex loads project hooks only after the maintainer trusts them with `/hooks`, and again after every change to them. Gaps: Codex has no secret-file read denial; each hook command maps every failure to exit code 2, but whether a timed-out hook blocks is undocumented.
- Other agent tools read `AGENTS.md` and get no guards; for them, only the maintainer's local hooks and CI apply.

## Exemplars

None yet.

## Language

The entry files, architecture.md and this file are in English. Other documents on this side are written in English; field names, section headings, IDs and paths stay in English.
