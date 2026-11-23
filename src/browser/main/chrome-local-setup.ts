import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';

export const CHROME_SETUP_TIMEOUT_MS = 5 * 60_000;

// How often the page asks for the extension, and how many answers in a row must fail before setup
// says that it is missing. An extension of another build reloads itself when asked, and meanwhile
// does not answer.
const ASK_MS = 500;
const MISSING_AFTER = 4;

interface Extension {
  id: string;
  build: string;
}

// This page checks for the connector in the Chrome profile that opened it: the extension of this
// app's build, since an earlier one could not pair. Browser authority stays in the separate native
// pairing exchange.
export async function waitForLocalChromeExtension(
  extension: Extension,
  open: (url: string) => Promise<void>,
  onMissing: () => void,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const path = '/chrome-setup/' + randomUUID();
  const first = Promise.withResolvers<'missing' | 'ready'>();
  const ready = Promise.withResolvers<undefined>();
  let origin = '';
  const server = createServer((request, response) => {
    if (origin === '' || 'http://' + (request.headers.host ?? '') !== origin) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && request.url === path) {
      response
        .writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy':
            "default-src 'none'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
        })
        .end(
          `<!doctype html><title>3mukon-code Chrome setup</title><p>Setting up the 3mukon-code browser connector.</p><script src="${path}/probe.js" defer></script>`,
        );
      return;
    }
    if (request.method === 'GET' && request.url === path + '/probe.js') {
      response
        .writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
        .end(probe(extension));
      return;
    }
    if (request.method === 'POST' && request.headers.origin === origin) {
      if (request.url === path + '/ready') {
        response.writeHead(204).end(() => {
          first.resolve('ready');
          ready.resolve(undefined);
        });
        return;
      }
      if (request.url === path + '/missing') {
        response.writeHead(204).end();
        first.resolve('missing');
        return;
      }
    }
    response.writeHead(404).end();
  });
  const abort = Promise.withResolvers<never>();
  const stop = () => {
    abort.reject(signal.reason);
  };
  signal.addEventListener('abort', stop, { once: true });
  void abort.promise.catch(() => undefined);
  try {
    const listening = once(server, 'listening', { signal });
    server.listen(0, '127.0.0.1');
    await listening;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Chrome setup is unavailable.');
    origin = `http://127.0.0.1:${String(address.port)}`;
    await open(origin + path);
    if ((await Promise.race([first.promise, abort.promise])) === 'missing') {
      onMissing();
      await Promise.race([ready.promise, abort.promise]);
    }
  } finally {
    signal.removeEventListener('abort', stop);
    server.close();
    server.closeAllConnections();
  }
}

function probe({ id, build }: Extension): string {
  return `
const extensionId = ${JSON.stringify(id)};
const build = ${JSON.stringify(build)};
const expiresAt = Date.now() + ${String(CHROME_SETUP_TIMEOUT_MS)};
let failed = 0;
let reportedMissing = false;
function report(installed) {
  failed = installed ? 0 : failed + 1;
  if (installed || (failed >= ${String(MISSING_AFTER)} && !reportedMissing)) {
    fetch(location.pathname + (installed ? '/ready' : '/missing'), { method: 'POST' })
      .then((response) => {
        if (installed && response.ok) {
          document.querySelector('p').textContent = 'Connector found. Return to 3mukon-code.';
          window.close();
        } else if (installed) setTimeout(check, ${String(ASK_MS)});
        else reportedMissing = response.ok;
      })
      .catch(() => { if (installed) setTimeout(check, ${String(ASK_MS)}); });
  }
  if (!installed) setTimeout(check, ${String(ASK_MS)});
}
function check() {
  if (Date.now() >= expiresAt) {
    document.querySelector('p').textContent = 'Setup ended. Return to 3mukon-code.';
    return;
  }
  const runtime = globalThis.chrome?.runtime;
  if (!runtime?.sendMessage) {
    report(false);
    return;
  }
  try {
    runtime.sendMessage(extensionId, { kind: 'connector-available' }, (result) => {
      void runtime.lastError;
      report(result === build);
    });
  } catch {
    report(false);
  }
}
check();
`;
}
