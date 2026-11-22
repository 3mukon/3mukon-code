const status = document.getElementById('status');
const ticket = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
const connected = await chrome.runtime.sendMessage({ kind: 'pair', ticket }).catch(() => false);
status.textContent = connected
  ? 'Connected. Return to 3mukon-code.'
  : 'Connection declined. Start setup again in 3mukon-code.';
/* global chrome, document, history, location */
