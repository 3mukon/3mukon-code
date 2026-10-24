---
id: DOC-architecture
type: doc
title: 3mukon-code hard base
status: current
visibility: public
date: 2026-10-23
summary: Publishable code and docs for a macOS-only desktop app that drives coding agents, sliced into feature modules and bound by nine invariants, protected files and change rules
scope: []
tags: []
framework: project-foundation@0.1.0
---

This file is part of this repository's hard base, together with the files listed under Protected files and the Document core section of `docs/conventions.md`. Only the maintainer changes them: propose a change to the maintainer with the reason and its impact.

## Plane

- Code and `docs/` contain only publishable content: technical facts and reasons, public IDs (`ADR-NNNN`, `L-NNNN`, `DOC-<slug>`) and paths inside this repository.
- They never reference deliberation records, and never carry internal context such as customer names, costs, schedules or local machine paths.
- Secrets are outside this repository and outside agent context altogether.
- Documents here call the person who owns the hard base "the maintainer".

## Layers

| Layer | Where it lives here |
|---|---|
| Code | Feature module directories, each with a README from `docs/templates/module-readme.md` and listed in `docs/INDEX.md` (Modules). None yet: the first module arrives with the first code. |
| Verification | `sh scripts/check.sh` runs every fast check. Code checks skip visibly while there is no application code and fail when code exists without checks wired into `scripts/checks/code.sh`. |
| Knowledge | `docs/`: this file, `conventions.md`, `glossary.md`, ADRs, lessons and current-state docs, indexed in `docs/INDEX.md`. |
| Agent access | `AGENTS.md` is the single entry; `CLAUDE.md` only imports it. Agent settings: `.claude/settings.json` (Claude Code) and `.codex/hooks.json` (Codex). |
| Governance | The maintainer's local hooks (secret scanning, publishability check, identity check, at commit and at push); CI in `.github/workflows/checks.yml` (secret scanning and the check command); agent settings and the guards in `scripts/guard/`. |

## Module rules

- Slice by feature (a capability of the app), and layer inside a module. A task should need one module plus the public interfaces of its neighbours.
- Each module has a README that states its responsibilities, non-responsibilities, public interface and allowed dependencies. Other modules use only that interface.
- Dependency directions are declared in the module READMEs. Enforcement is planned: the change that adds the first code chooses a tool for the stack and wires it into `scripts/checks/code.sh`.
- Code that runs on remote hosts lives in modules separate from desktop app modules, so that invariant 8 can be checked per module.
- The module that new code imitates is named only in `docs/conventions.md` (Exemplars).

## Invariants

| # | Rule | Rationale | Check |
|---|---|---|---|
| 1 | Code and `docs/` contain only publishable content and never reference deliberation records | The same agents that read private context also write this repository; only structure keeps the two apart | The maintainer's local hooks run the publishability check on content, file names, commit messages and pushed ref names |
| 2 | Secrets never enter this repository or agent context | Agent context leaves the machine and can be exfiltrated by injected instructions | gitleaks in the local hooks and in CI; agent settings deny reading secret files |
| 3 | Commit messages, branch and tag names, PRs, issues and releases give only technical reasons and cite only public IDs | Text written by agents is where private context leaks most easily | The publishability check on commit messages and pushed ref names; the maintainer's sessions check outgoing text before it reaches the host |
| 4 | Decisions, lessons and current state are written from `docs/templates/` with stable IDs; core fields and required sections are never removed | Agents forget everything between sessions, and a tool's own memory is lost when the tool changes | `scripts/checks/docs.sh` checks core fields and that `docs/INDEX.md` repeats each document's ID, status, title and summary |
| 5 | Each fact has one authoritative home; current-state docs change in the same change as the code | Stale documentation is worse than none, because agents believe it | None; review |
| 6 | Nothing is declared done without `sh scripts/check.sh` passing, and checks are never weakened to pass | A blocked agent takes detours: editing tests, adding skips, bypassing hooks | CI runs the check command; it becomes a required status check once the remote exists (not live yet). The bypass guard blocks hook bypasses |
| 7 | Only the maintainer changes the hard base and the guardrails | The constrained party cannot rewrite its own rules | Claude Code asks before protected files are edited; the Codex hook refuses patches to them |
| 8 | The desktop app supports macOS only: no Windows or Linux desktop builds, packaging targets or platform branches in desktop app code. Components that run on remote hosts may run on Linux | Dropping the other desktop platforms removes platform branches and lets the app use macOS facilities directly | Planned: the change that adds the first desktop app code adds a check that rejects non-macOS packaging targets and Windows or Linux platform branches in desktop modules |
| 9 | The app and its remote host components never read, store or transmit provider API keys or tokens; providers and third-party gateways are signed in and configured through the providers' own tools and settings (ADR-0001) | Keys the app never holds cannot leak through it | Planned: the change that adds the first provider integration adds a check that rejects API-key settings and key environment variables in app and remote component code. Until then, secret scanning catches committed keys |

## Protected files

- `docs/architecture.md` (this file)
- The Document core section of `docs/conventions.md`, protected by this rule only
- `AGENTS.md`, `CLAUDE.md`
- `LICENSE`, once added
- `.github/workflows/` (CI configuration)
- `.github/CODEOWNERS`, once added
- `scripts/check.sh` and `scripts/checks/` (the check command's scripts)
- `.gitleaks.toml` (scanning configuration), once added
- `.claude/settings.json` and `.codex/` (agent settings)
- `scripts/guard/` (guardrail scripts, their path list and their tests)
- `.git/hooks/` (the maintainer's local hook wrappers, which are not versioned)

The ask rules in `.claude/settings.json` and the list in `scripts/guard/protected-paths.txt` enforce this list. The maintainer updates them in the same change as the list.

## Change rules

| Tier | Scope | Who may change it |
|---|---|---|
| Hard base | This file, the files under Protected files, the Document core section of `docs/conventions.md` | Only the maintainer; agents propose the change with its reason and impact |
| Conventions | `docs/conventions.md` outside Document core, the templates, details inside directories | Agents: an ADR when there is a trade-off, otherwise the reason in the commit message |
| Details | Wording, naming, scripts other than guardrails | Agents, freely |

A change is major when it does any of these:

- changes a plane boundary or a reference direction;
- splits, merges or deletes an existing module, or changes its responsibilities, dependency directions, data ownership or public contract;
- changes or violates an invariant;
- changes where or how this repository is published.

Only a change in requirements can trigger a major change, and the maintainer must confirm it. Adding a module is a convention-tier change.
