const commands = new Set([
  'Target.getTargetInfo',
  'Page.enable',
  'Page.getFrameTree',
  'Page.createIsolatedWorld',
  'Page.captureScreenshot',
  'Page.navigate',
  'Page.bringToFront',
  'Page.handleJavaScriptDialog',
  'Runtime.evaluate',
]);

const pageEvents = new Set([
  'Page.frameNavigated',
  'Page.navigatedWithinDocument',
  'Page.frameResized',
  'app.active-popup',
]);
const renderableDocument =
  /^(text\/(html|plain|xml)|application\/(xhtml\+xml|json|xml)|image\/(png|jpeg|gif|webp))(\s*;|\s*$)/i;
const redirects = new Set([301, 302, 303, 307, 308]);
const pagePolicy = 'sandbox allow-same-origin allow-scripts allow-forms';
const limit = 32;

export class TaskTabs {
  #tabs = new Set();
  #opening = 0;
  #closed = false;

  constructor(browser, emit) {
    this.browser = browser;
    this.emit = emit;
  }

  async request(action) {
    if (this.#closed) throw new Error('Chrome connection ended.');
    if (action.kind === 'create-tab') return this.#create();
    if (!this.#tabs.has(action.tab)) throw new Error('Tab is outside this connection.');
    if (action.kind === 'close-tab') {
      await this.browser.tabs.remove(action.tab);
      this.ended(action.tab);
      return null;
    }
    if (action.kind !== 'command' || !commands.has(action.method))
      throw new Error('Unsupported command.');
    if (action.method === 'Page.navigate') {
      const url = new URL(action.params.url);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
        throw new Error('Unsupported address.');
    }
    return this.browser.debugger.sendCommand({ tabId: action.tab }, action.method, action.params);
  }

  async #create() {
    if (this.#tabs.size + this.#opening >= limit) throw new Error('Too many task tabs.');
    this.#opening++;
    try {
      if (!(await this.browser.permissions.contains({ origins: ['http://*/*', 'https://*/*'] })))
        throw new Error('Chrome has withheld website access.');
      const window = await this.browser.windows.getLastFocused({ windowTypes: ['normal'] });
      if (this.#closed || window.type !== 'normal' || window.incognito || window.id == null)
        throw new Error('No normal window in the connected profile.');
      const tab = await this.browser.tabs.create({
        windowId: window.id,
        active: false,
        url: 'about:blank',
      });
      if (!Number.isInteger(tab.id)) throw new Error('Chrome did not create a tab.');
      try {
        if (this.#closed || tab.incognito) throw new Error('Tab is unavailable.');
        this.#tabs.add(tab.id);
        const target = { tabId: tab.id };
        const debuggerApi = this.browser.debugger;
        await debuggerApi.attach(target, '1.3');
        // For this task tab, every navigation needs to pass the response policy.
        await this.browser.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [tab.id],
          addRules: [
            {
              id: tab.id,
              condition: { tabIds: [tab.id], resourceTypes: ['main_frame', 'sub_frame'] },
              action: {
                type: 'modifyHeaders',
                responseHeaders: [
                  { header: 'content-security-policy', operation: 'append', value: pagePolicy },
                ],
              },
            },
          ],
        });
        await debuggerApi.sendCommand(target, 'Network.setCacheDisabled', { cacheDisabled: true });
        await debuggerApi.sendCommand(target, 'Network.setBypassServiceWorker', { bypass: true });
        await debuggerApi.sendCommand(target, 'Fetch.enable', {
          patterns: [{ resourceType: 'Document', requestStage: 'Response' }],
        });
        await debuggerApi.sendCommand(target, 'Page.setInterceptFileChooserDialog', {
          enabled: true,
        });
        if (this.#closed || !this.#tabs.has(tab.id)) throw new Error('Tab has ended.');
        return { tab: tab.id };
      } catch (error) {
        this.#tabs.delete(tab.id);
        await this.browser.tabs.remove(tab.id).catch(() => undefined);
        await this.#removePolicy([tab.id]);
        throw error;
      }
    } finally {
      this.#opening--;
    }
  }

  event(tab, method, value) {
    if (!this.#tabs.has(tab)) return;
    if (method === 'Fetch.requestPaused') {
      void this.#documentResponse(tab, value).catch(() => this.detached(tab));
    } else if (method === 'Page.javascriptDialogOpening') {
      this.emit({ kind: 'tab-event', tab, method, value: { type: value?.type } });
    } else if (pageEvents.has(method)) {
      this.emit({ kind: 'tab-event', tab, method, value });
    }
  }

  async #documentResponse(tab, paused) {
    const { requestId, responseStatusCode, responseHeaders = [] } = paused;
    const attachment = responseHeaders.some(
      ({ name, value }) =>
        name.toLowerCase() === 'content-disposition' && /^\s*attachment\b/i.test(value),
    );
    const renderable = responseHeaders.some(
      ({ name, value }) => name.toLowerCase() === 'content-type' && renderableDocument.test(value),
    );
    const redirect =
      redirects.has(responseStatusCode) &&
      responseHeaders.some(({ name, value }) => name.toLowerCase() === 'location' && value.trim());
    const target = { tabId: tab };
    const debuggerApi = this.browser.debugger;
    if (!attachment && (redirect || (renderable && responseStatusCode !== 304))) {
      await debuggerApi.sendCommand(target, 'Fetch.continueRequest', { requestId });
    } else {
      await debuggerApi.sendCommand(target, 'Fetch.failRequest', {
        requestId,
        errorReason: 'BlockedByClient',
      });
    }
  }

  ended(tab) {
    if (!this.#tabs.delete(tab)) return;
    void this.#removePolicy([tab]);
    this.emit({ kind: 'tab-ended', tab });
  }

  async detached(tab) {
    if (!this.#tabs.has(tab)) return;
    this.ended(tab);
    await this.browser.tabs.remove(tab).catch(() => undefined);
  }

  async close() {
    this.#closed = true;
    const tabs = [...this.#tabs];
    this.#tabs.clear();
    await Promise.allSettled(tabs.map((tab) => this.browser.tabs.remove(tab)));
    await this.#removePolicy(tabs);
  }

  #removePolicy(tabs) {
    return this.browser.declarativeNetRequest
      .updateSessionRules({ removeRuleIds: tabs })
      .catch(() => undefined);
  }
}
/* global URL */
