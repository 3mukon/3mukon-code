---
id: ADR-0012
type: adr
title: Let Codex ask through its own question tool, and keep serving the app's MCP toolset, without tools, for the tools to come
status: accepted
visibility: public
date: 2026-10-31
summary: Codex 0.164.0 offers its async question tool in its default mode, so the toolset's question tool goes and Codex asks through its own; the toolset keeps its design, a stateless streamable HTTP server in the main process on the loopback interface with a credential per session, and Codex's sessions keep connecting to it, now listing no tools
scope: ["src/toolset/**", "src/sessions/main/provider.ts", "src/providers/codex/**"]
tags: []
supersedes: [ADR-0009]
superseded_by:
---

## Context

ADR-0009 gave the app a toolset of its own, named 3mukon-code, because Codex had no question tool outside its plan mode; the toolset's one tool asked the user questions. Codex 0.164.0 now gives the model `request_user_input_async` in its default mode: the call returns at once, Codex reports the questions on an agent message of their own, and the user's reply arrives as their next message. The app shows those questions as questions (DOC-mod-codex). Codex also defers every MCP tool behind its tool search (`tool_search_always_defer_mcp_tools`, always on), so a model seldom found the toolset's question tool beside its own. Claude Code and Grok Build ask through their own question tools. No provider lacks a question tool any more, and more of the app's own tools are expected later.

Constraints, as in ADR-0009:

- Each session's provider process may use the toolset, and nothing else may: not another session's process, not a web page, not another machine.
- The toolset's credential is the app's own and opens only the toolset; it is no provider credential (invariant 9, ADR-0008).
- Codex reaches MCP servers over stdio or streamable HTTP, with a bearer credential read from an environment variable named in its configuration.

New: Codex asks every MCP server for its tools (`tools/list`) once the server has initialized, even one that offers none, and a required server that cannot answer keeps Codex from starting a thread. Checked against Codex 0.164.0: with an MCP server that registered no tools, `thread/start` failed with "required MCP servers failed to initialize: Method not found".

## Options

| Area | Chosen | Rejected | Why |
|---|---|---|---|
| Codex's question tool | Codex's own `request_user_input_async`, shown as a question that the user's next message answers | The toolset's question tool beside Codex's own; enabling `default_mode_request_user_input`, under which `request_user_input` waits for the answer within the turn | The model finds Codex's own tool, and the toolset's is deferred behind tool search; the feature is still under development in 0.164.0 |
| The toolset | Kept, with no tools, so that later tools reach the sessions without new wiring | Removed with its question tool, to return when a tool needs it | More tools are planned; the server, its credentials and Codex's connection are what each of them needs |
| A toolset without tools | It declares the tools capability and lists no tools | Registering no tools at all, as the MCP SDK's `McpServer` allows | Without a listing, Codex starts no thread while the toolset is required |
| Where it runs | An HTTP server in the main process, on 127.0.0.1 at a port the system chooses, shared by all sessions | A stdio MCP server that each provider process starts, relaying to the app over a local socket; the HTTP server on a Unix socket | As in ADR-0009: a relay is a second channel needing the same credential and a packaged executable, and Codex names an HTTP MCP server only by its URL |
| Library | The official MCP TypeScript SDK, `@modelcontextprotocol/sdk` 1.32.1 | A hand-written MCP endpoint | As in ADR-0009 |
| MCP sessions | Stateless: each POST request gets an MCP server and transport of its own, and GET and DELETE are refused | Stateful MCP sessions with session ids | Nothing to keep or clean up per MCP session |
| Who may call | One random credential per session, 32 bytes, sent as a bearer credential and looked up by its SHA-256 digest; requests must name the server's own address as Host and carry no Origin | The loopback interface alone; one credential for the whole app | As in ADR-0009: any local process reaches the loopback interface, a shared credential would let one session act for another, and Host and Origin keep out web pages |
| How Codex learns of it | `-c mcp_servers.3mukon-code.*` overrides on the session's `codex app-server` command line, its tools allowed without asking, the credential in an environment variable whose name contains `TOKEN`, and the server required | The thread's configuration in `thread/start`; the credential as an `http_headers` literal | As in ADR-0009. The year-long call timeout that a waiting question needed is gone with it |

## Decision

The toolset module serves the toolset as in the Chosen column, with no tools: it declares the tools capability and lists none. The sessions module's provider interface defines `Toolset`, whose `open()` gives a session its access, and `ToolsetAccess`; the app module starts the toolset and hands it to the Codex adapter, which opens it for every session it runs. Codex asks the user through its own async question tool. A tool joins the toolset only as a decision of its own, and the first one registered through the SDK's `registerTool` takes over the listing.

## Consequences

- Easier: a tool added later reaches Codex's sessions through the existing server and settings; Codex's questions come through the tool its model knows.
- Harder: the app keeps running a local HTTP server that serves no tools, and Codex starts no thread while it cannot reach it. Codex's async questions take one choice or typed text each, with no descriptions and no multiple choice, and their answers reach the agent as a message rather than within the call.
- Must stay true: the server listens on the loopback interface only; a request without an open access's credential, with an Origin, or with another Host is refused; a credential lives in memory only while its access lasts and is never logged, stored or shown; the toolset lists only the tools its README names.

## Revisit when

A tool joins the toolset; another provider needs one of its tools; Codex no longer lists the tools of a server that offers none, or stops requiring a listing of a required server; Codex's `request_user_input` waits for the answer in its default mode as a stable feature.
