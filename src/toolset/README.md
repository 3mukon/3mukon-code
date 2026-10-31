---
id: DOC-mod-toolset
type: doc
title: toolset module
status: current
visibility: public
date: 2026-10-26
summary: The app's own MCP toolset, 3mukon-code, which the main process serves over local streamable HTTP to each session's provider process with a credential of its own, and which has no tools yet
scope: ["src/toolset/**"]
tags: []
---

## Responsibilities

- `startToolset({ version })` (`main/server.ts`) serves the toolset (ADR-0012): an HTTP server on 127.0.0.1 at a port the system chooses, with MCP's streamable HTTP transport at `/mcp`, on the MCP TypeScript SDK in its stateless mode. Each POST request gets an MCP server and transport of its own; GET and DELETE are refused.
- Access: the toolset implements the sessions module's `Toolset`. `open()` gives a session a credential of its own, 32 random bytes, which the provider sends as a bearer credential; the access's `close()` ends it. A request needs the credential of an open access, must name the server's own address as its Host and must carry no Origin, so web pages cannot reach the toolset, directly or through a rebound name.
- Tools: none in this version. The server declares the tools capability and lists no tools, since Codex asks every MCP server for its tools and starts no thread while a required one cannot list them. The first tool registered through the SDK's `registerTool` lists the tools itself, and the empty listing goes with it.

## Not responsible for

- Telling a provider about the toolset: each adapter that needs it configures its provider; the Codex adapter does for every session (DOC-mod-codex).
- Starting and stopping the toolset: the app module does, once for the app.
- Provider credentials: a session's credential is the app's own and opens only the toolset (ADR-0008, ADR-0012).

## Interface

- From `main/server.ts`, for the app module only: `startToolset({ version })`, which resolves with a `RunningToolset`, the sessions module's `Toolset` with `close()`; its `name`, `3mukon-code`, is the name providers list it under, also exported as `TOOLSET_NAME`.

## Dependencies

- Uses only the sessions module's interface (`src/sessions/main/provider.ts`), `@modelcontextprotocol/sdk` and Node.js built-ins.
- Only the app module may import it, and a provider adapter's live test, which composes the adapter with the toolset as the app does. The rules `toolset-only-to-sessions-contract`, `toolset-only-from-app` and `provider-live-tests-compose-as-the-app` in `.dependency-cruiser.js` enforce this.

## Invariants

- The server listens on the loopback interface only.
- A credential lives in memory only, while its access lasts, and is never logged, stored or shown.
- A request acts only for the session whose credential it carries.
- The toolset offers only the tools this README lists, none in this version; each new tool is a decision of its own.
- The unit tests (`main/server.test.ts`) drive the toolset with the MCP SDK's own client, and with plain HTTP requests for the headers that fetch keeps to itself.
