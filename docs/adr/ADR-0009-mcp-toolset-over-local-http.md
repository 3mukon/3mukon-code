---
id: ADR-0009
type: adr
title: Serve the app's MCP toolset from the main process over local streamable HTTP, with a credential per session
status: proposed
visibility: public
date: 2026-10-26
summary: The app serves its own MCP toolset, 3mukon-code, from the main process with the official MCP TypeScript SDK in its stateless streamable HTTP mode, on the loopback interface, where each session's provider process authenticates with a random credential of its own; a stdio relay, a hand-written endpoint and Codex's experimental dynamic tools and plan mode were rejected
scope: ["src/toolset/**", "src/sessions/main/provider.ts", "src/providers/codex/**"]
tags: []
supersedes: []
superseded_by:
---

## Context

Some providers lack a tool that a session needs. Codex offers its question tool, `request_user_input`, only in its plan collaboration mode, which needs the experimental app-server API, so a Codex agent in its default mode cannot ask the user anything during a turn. The app therefore serves a toolset of its own, named 3mukon-code, whose first tool asks the user questions and waits for the answers.

Constraints:

- Each session's provider process may use the toolset, and nothing else may: not another session's process, not a web page, not another machine.
- The toolset's credential is the app's own and opens only the toolset; it is no provider credential (invariant 9, ADR-0008).
- Codex reaches MCP servers over stdio or streamable HTTP. For HTTP it sends a bearer credential that it reads from an environment variable named in its configuration (`bearer_token_env_var`), and the approval of a server's tools can be preset, for all of them (`default_tools_approval_mode`) or one by one (`tools.<tool>.approval_mode`).
- A question waits for the user with no time limit of its own, and ends when the user answers or declines, the turn is interrupted or the session closes.
- Each Codex session runs an app-server process of its own (DOC-mod-codex).

## Options

| Area | Chosen | Rejected | Why |
|---|---|---|---|
| Where it runs | An HTTP server in the main process, on 127.0.0.1 at a port the system chooses, shared by all sessions | A stdio MCP server that each provider process starts, relaying to the app over a local socket | The main process already holds the sessions; a relay is an executable to package and a second channel, and its socket needs the same credential |
| Library | The official MCP TypeScript SDK, `@modelcontextprotocol/sdk` 1.32.1, with `zod` 4.6.7 for the tool's schemas, both bundled into the main process | A hand-written MCP endpoint | Protocol versions, SSE streams, keep-alives, cancellation and schema validation are what the SDK maintains; 1.32.2 was three days old |
| MCP sessions | Stateless: each POST request gets an MCP server and transport of its own, and GET and DELETE are refused | Stateful MCP sessions with session ids | Nothing to keep or clean up per MCP session; a call holds its own request open while it waits. A cancellation arrives in a request of its own, so the toolset finds the call it names by request id |
| Who may call | One random credential per session, 32 bytes, sent as a bearer credential and looked up by its SHA-256 digest; requests must name the server's own address as Host and carry no Origin | The loopback interface alone; one credential for the whole app | Any local process can reach the loopback interface, and a shared credential would let one session's process act for another; Host and Origin keep out web pages, directly or through a rebound name |
| How Codex learns of it | `-c mcp_servers.3mukon-code.*` overrides on the session's `codex app-server` command line, with the credential in an environment variable of that process whose name contains `TOKEN` | The thread's configuration in `thread/start`; the credential as an `http_headers` literal | The command line holds only the address and the variable's name; Codex's default shell environment policy keeps variables whose names contain `TOKEN` out of the commands it runs |
| Codex's own ways | Codex's own `request_user_input` stays off | Turning on the experimental API, for plan mode's `request_user_input` or for dynamic tools (`dynamicTools` on `thread/start`, answered through `item/tool/call`) | The experimental API changes without notice; plan mode changes how Codex works, and dynamic tools would serve Codex alone |

## Decision

The `toolset` module serves the toolset as in the Chosen column. The sessions module's provider interface defines `Toolset`, `ToolsetSession` and `ToolsetAccess`; the app module starts the toolset and hands it to the adapters whose providers lack one of its tools, and each such adapter opens it for every session it runs. The Codex adapter does so for every session, presets the toolset's tools to run without approval and gives them no timeout that a waiting question could reach. The question tool shows its questions as one question request of the session, and returns `cancelled` once the request is declined or cancelled, the provider gives the call up, or the access or the toolset closes.

## Consequences

- Easier: a provider that speaks MCP gets the app's tools through its configuration alone; the toolset is tested with the SDK's own client; the question tool works in every Codex mode and sandbox level.
- Harder: the app runs a local HTTP server; the bundled main process carries the MCP SDK and the parts of its dependencies it uses; cancellations in stateless mode are routed by the toolset rather than by the SDK.
- Must stay true: the server listens on the loopback interface only; a request without an open access's credential, with an Origin, or with another Host is refused; a credential lives in memory only while its access lasts and is never logged, stored or shown; a call acts only for the session whose credential it carries; the toolset offers only the tools its README lists, and each new tool is a decision of its own.

## Revisit when

Codex's question tool or dynamic tools reach its stable API; the MCP SDK's next major version changes the server API; another provider, such as Grok Build, needs a tool of the toolset.
