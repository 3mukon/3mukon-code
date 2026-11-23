import { build } from './build.js';
import { TaskTabs } from './task-tabs.js';

const nativeHost = 'io.github.sanmukon.browser';
const retryAlarm = 'connect-saved-browser';
const proofFormat = /^[a-f0-9]{64}$/;
let connection;

// The build the extension's folder holds, which the app renews as it is updated. Chrome goes on
// running the worker it loaded, after a restart too, until the extension reloads.
async function folderBuild() {
  try {
    const response = await fetch(chrome.runtime.getURL('build.js'), { cache: 'no-store' });
    return /'([a-z0-9]{1,64})'/.exec(await response.text())?.[1];
  } catch {
    return undefined;
  }
}

// Whether this worker may go on. One whose folder holds another build reloads the extension instead,
// once for each build, and never while it has a connection, whose task tabs the reload would leave.
async function mayGoOn() {
  const found = await folderBuild();
  if (found === undefined || found === build) return true;
  const { reloadedFor } = await chrome.storage.local.get('reloadedFor');
  if (reloadedFor === found || connection) return true;
  await chrome.storage.local.set({ reloadedFor: found });
  chrome.runtime.reload();
  return false;
}

function send(current, message) {
  if (connection !== current) return;
  try {
    current.port.postMessage(message);
  } catch {
    current.port.disconnect();
  }
}

async function receive(current, message) {
  if (connection !== current || !message || typeof message !== 'object') return;
  if (
    message.kind === 'paired' &&
    current.reply &&
    typeof message.proof === 'string' &&
    proofFormat.test(message.proof)
  ) {
    await chrome.storage.local.set({ proof: message.proof });
    send(current, { kind: 'pair-saved' });
    return;
  }
  if (message.kind === 'ready' && !current.ready) {
    current.ready = true;
    current.reply?.(true);
    current.reply = undefined;
    return;
  }
  if (!current.ready || message.kind !== 'request' || !Number.isSafeInteger(message.id)) return;
  try {
    if (message.action?.kind === 'forget') {
      await chrome.storage.local.remove('proof');
      await current.tabs.close();
    }
    const result =
      message.action?.kind === 'forget' ? null : await current.tabs.request(message.action);
    send(current, { kind: 'reply', id: message.id, ok: true, result: result ?? null });
  } catch {
    send(current, { kind: 'reply', id: message.id, ok: false });
  }
}

function connect(hello, reply) {
  if (connection) {
    reply?.(false);
    return;
  }
  const port = chrome.runtime.connectNative(nativeHost);
  const current = { port, reply, ready: false };
  current.tabs = new TaskTabs(chrome, (event) => send(current, event));
  connection = current;
  port.onMessage.addListener((message) => {
    void receive(current, message).catch(() => port.disconnect());
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (connection !== current) return;
    connection = undefined;
    current.reply?.(false);
    void current.tabs.close();
  });
  send(current, hello);
}

async function restore() {
  if (connection || !(await mayGoOn())) return;
  const { proof } = await chrome.storage.local.get('proof');
  if (typeof proof === 'string' && proofFormat.test(proof))
    connect({ kind: 'restore', proof, build });
}

// The temporary setup page learns only whether this profile can see the extension, and its build.
chrome.runtime.onMessageExternal.addListener((message, sender, reply) => {
  if (
    message?.kind !== 'connector-available' ||
    sender.frameId !== 0 ||
    !/^http:\/\/127\.0\.0\.1:\d+\/chrome-setup\/[a-f0-9-]{36}$/.test(sender.url ?? '')
  )
    return false;
  void mayGoOn().then((goesOn) => {
    if (goesOn) reply(build);
  });
  return true;
});

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (
    sender.id !== chrome.runtime.id ||
    sender.url?.split('#', 1)[0] !== chrome.runtime.getURL('pair.html') ||
    message?.kind !== 'pair' ||
    typeof message.ticket !== 'string' ||
    !proofFormat.test(message.ticket)
  )
    return false;
  const pending = connection;
  if (pending && !pending.ready) {
    connection = undefined;
    pending.port.disconnect();
    pending.reply?.(false);
    void pending.tabs.close();
  }
  const setupTab = sender.tab?.id;
  connect({ kind: 'pair', ticket: message.ticket, build }, (ready) => {
    reply(ready);
    if (ready && Number.isInteger(setupTab))
      void chrome.tabs.remove(setupTab).catch(() => undefined);
  });
  return true;
});
chrome.tabs.onRemoved.addListener((tab) => connection?.tabs.ended(tab));
chrome.permissions.onRemoved.addListener(({ origins }) => {
  if (origins?.length) connection?.port.disconnect();
});
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.active) connection?.tabs.event(tab.openerTabId, 'app.active-popup', null);
});
chrome.debugger.onEvent.addListener((source, method, value) => {
  if (!source.sessionId) connection?.tabs.event(source.tabId, method, value ?? null);
});
chrome.debugger.onDetach.addListener((source) => {
  if (!source.sessionId) void connection?.tabs.detached(source.tabId);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === retryAlarm) void restore();
});
// Chrome started: a build that a reload did not bring before may be reloaded for again.
chrome.runtime.onStartup.addListener(() => {
  void chrome.storage.local.remove('reloadedFor').then(restore);
});
void chrome.alarms.get(retryAlarm).then((alarm) => {
  if (!alarm) return chrome.alarms.create(retryAlarm, { periodInMinutes: 0.5 });
});
void restore();
/* global chrome, fetch */
