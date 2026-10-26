---
id: DOC-mod-toolset
type: doc
title: toolset module
status: current
visibility: public
date: 2026-10-26
summary: The app's own MCP toolset, 3mukon-code, which the main process serves over local streamable HTTP to each session's provider process with a credential of its own, and whose one tool asks the user questions
scope: ["src/toolset/**"]
tags: []
---

## Responsibilities

- `startToolset({ version })` (`main/server.ts`) serves the toolset (ADR-0009): an HTTP server on 127.0.0.1 at a port the system chooses, with MCP's streamable HTTP transport at `/mcp`, on the MCP TypeScript SDK in its stateless mode. Each POST request gets an MCP server and transport of its own, so a call waits for as long as its request lasts; GET and DELETE are refused.
- Access: the toolset implements the sessions module's `Toolset`. `open(session)` gives the session a credential of its own, 32 random bytes, which the provider sends as a bearer credential; the access's `close()` ends it. A request needs the credential of an open access, must name the server's own address as its Host and must carry no Origin, so web pages cannot reach the toolset, directly or through a rebound name.
- The question tool, `ask_user` (`main/ask-user.ts`): one to four questions, each with up to eight options, for one choice or several; every question also takes typed text. The session shows them as one question request. The result holds `status`, `answered` or `cancelled`, and one answer per question in the order asked, with the labels chosen and any text typed, as structured content and as the same JSON in text. The tool is marked read-only and not destructive.
- A call waits with no time limit of its own. It ends when the session resolves it, answered, declined, or cancelled because the turn was interrupted or the session closed; when the provider gives it up, by closing its request or by a cancellation, which the toolset finds by request id; or when the access or the toolset closes. Each of the last three returns `cancelled` where the request is still open.

## Not responsible for

- Showing questions and taking answers: the session does, through the adapter that opened the access.
- Telling a provider about the toolset: each adapter that needs it configures its provider; the Codex adapter does for every session (DOC-mod-codex).
- Starting and stopping the toolset: the app module does, once for the app.
- Provider credentials: a session's credential is the app's own and opens only the toolset (ADR-0008, ADR-0009).

## Interface

- From `main/server.ts`, for the app module only: `startToolset({ version })`, which resolves with a `RunningToolset`, the sessions module's `Toolset` with `close()`; its `name`, `3mukon-code`, is the name providers list it under, also exported as `TOOLSET_NAME`.

## Dependencies

- Uses only the sessions module's interface and model (`src/sessions/main/provider.ts` and `src/sessions/shared/`), `@modelcontextprotocol/sdk`, `zod` and Node.js built-ins.
- Only the app module may import it, and a provider adapter's live test, which composes the adapter with the toolset as the app does. The rules `toolset-only-to-sessions-contract`, `toolset-only-from-app` and `provider-live-tests-compose-as-the-app` in `.dependency-cruiser.js` enforce this.

## Invariants

- The server listens on the loopback interface only.
- A credential lives in memory only, while its access lasts, and is never logged, stored or shown.
- A call acts only for the session whose credential it carries.
- The toolset offers only the tools this README lists; each new tool is a decision of its own.
- The unit tests (`main/server.test.ts`) drive the toolset with the MCP SDK's own client, and with plain HTTP requests for the headers that fetch keeps to itself.
