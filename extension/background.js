// browser-ext service worker.
//
// Maintains a persistent native-messaging port to the Rust host. The host
// also listens on a Unix socket for CLI clients and relays their requests
// here as { id, method, params } messages; we answer with { id, result } or
// { id, error }. Each request is dispatched to a handler that wraps the
// chrome.* APIs.

const NATIVE_HOST = 'com.browser_ext.host';

let port = null;
let reconnectTimer = null;

function connect() {
  if (port) return;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    console.error(`[browser-ext] connectNative failed: ${e}`);
    scheduleReconnect();
    return;
  }

  console.log('[browser-ext] connected to native host');

  port.onMessage.addListener((msg) => {
    handleRequest(msg).catch((e) => {
      console.error(`[browser-ext] dispatch error: ${e?.stack || e}`);
    });
  });

  port.onDisconnect.addListener(() => {
    console.error(
      `[browser-ext] native host disconnected: ${chrome.runtime.lastError?.message || ''}`,
    );
    port = null;
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (!reconnectTimer) {
    reconnectTimer = setTimeout(connect, 3000);
  }
}

function send(msg) {
  if (!port) {
    console.error('[browser-ext] send dropped, no port');
    return;
  }
  try {
    port.postMessage(msg);
  } catch (e) {
    console.error(`[browser-ext] postMessage failed: ${e}`);
  }
}

// --- Request dispatch ---

async function handleRequest(msg) {
  const { id, method, params } = msg;
  if (id === undefined || method === undefined) return;

  const handler = HANDLERS[method];
  if (!handler) {
    send({ id, error: `unknown method: ${method}` });
    return;
  }

  try {
    const result = await handler(params || {});
    send({ id, result });
  } catch (e) {
    send({ id, error: e?.message || String(e) });
  }
}

// --- Handlers ---
//
// Keep each handler small and self-contained so new verbs drop in as extra
// entries. Each wraps a chrome.tabs.* / chrome.windows.* / chrome.scripting.*
// call and returns a JSON-serializable result.

const HANDLERS = {
  'tabs.list': async () => {
    const tabs = await chrome.tabs.query({});
    return tabs.map((t) => ({
      id: t.id,
      windowId: t.windowId,
      title: t.title ?? '',
      url: t.url ?? t.pendingUrl ?? '',
      active: !!t.active,
      pinned: !!t.pinned,
    }));
  },

  'tabs.content': async ({ id }) => {
    const tabId = requireTabId(id);
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractReadableText,
    });
    return { id: tabId, text: result ?? '' };
  },

  'tabs.close': async ({ ids }) => {
    const tabIds = (Array.isArray(ids) ? ids : [ids]).map(requireTabId);
    await chrome.tabs.remove(tabIds);
    return { closed: tabIds };
  },

  'tabs.open': async ({ url }) => {
    const tab = await chrome.tabs.create(url ? { url } : {});
    return {
      id: tab.id,
      windowId: tab.windowId,
      url: tab.url ?? tab.pendingUrl ?? '',
    };
  },

  'tabs.navigate': async ({ id, url }) => {
    const tabId = requireTabId(id);
    if (typeof url !== 'string' || url === '') {
      throw new Error('navigate needs a url');
    }
    const tab = await chrome.tabs.update(tabId, { url });
    return {
      id: tab.id,
      windowId: tab.windowId,
      url: tab.url ?? tab.pendingUrl ?? '',
    };
  },

  'tabs.activate': async ({ id }) => {
    const tabId = requireTabId(id);
    const tab = await chrome.tabs.update(tabId, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
    return { id: tab.id, windowId: tab.windowId };
  },

  'tabs.move': async ({ id, index, windowId }) => {
    const tabId = requireTabId(id);
    const moveProps = {};
    if (index !== undefined && index !== null) {
      const n = Number(index);
      if (!Number.isInteger(n)) {
        throw new Error(`invalid index: ${index}`);
      }
      moveProps.index = n;
    }
    if (windowId !== undefined && windowId !== null) {
      const w = Number(windowId);
      if (!Number.isInteger(w)) {
        throw new Error(`invalid window id: ${windowId}`);
      }
      moveProps.windowId = w;
    }
    if (moveProps.index === undefined) {
      throw new Error('move needs an index');
    }
    const moved = await chrome.tabs.move(tabId, moveProps);
    const tab = Array.isArray(moved) ? moved[0] : moved;
    return { id: tab.id, windowId: tab.windowId, index: tab.index };
  },

  // Plain `{ id }` captures the visible viewport with captureVisibleTab — no debugger, no infobar — but only the active tab, so it's focused first. Any of clip / selector / fullPage switches to CDP Page.captureScreenshot via chrome.debugger, the only API that clips a region, an element, or the whole page natively (no post-crop), needing neither focus nor page-eval — at the cost of the "is being debugged" infobar while attached.
  'tabs.screenshot': async ({ id, clip, selector, fullPage }) => {
    const tabId = requireTabId(id);
    if (!clip && !selector && !fullPage) {
      const tab = await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
      return { id: tab.id, windowId: tab.windowId, dataUrl };
    }
    const target = { tabId };
    await dbgAttach(target);
    try {
      const params = { format: 'png', captureBeyondViewport: true };
      if (selector) {
        const { root } = await dbgSend(target, 'DOM.getDocument', { depth: 0 });
        const { nodeId } = await dbgSend(target, 'DOM.querySelector', {
          nodeId: root.nodeId,
          selector,
        });
        if (!nodeId) throw new Error(`selector not found: ${selector}`);
        const { model } = await dbgSend(target, 'DOM.getBoxModel', { nodeId });
        const q = model.border;
        const xs = [q[0], q[2], q[4], q[6]];
        const ys = [q[1], q[3], q[5], q[7]];
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        params.clip = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, scale: 1 };
      } else if (clip) {
        params.clip = { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 };
      } else {
        const m = await dbgSend(target, 'Page.getLayoutMetrics', {});
        const s = m.cssContentSize || m.contentSize;
        params.clip = { x: 0, y: 0, width: s.width, height: s.height, scale: 1 };
      }
      const { data } = await dbgSend(target, 'Page.captureScreenshot', params);
      return { id: tabId, dataUrl: `data:image/png;base64,${data}` };
    } finally {
      await dbgDetach(target);
    }
  },

  // Clicks an element with a real mouse via CDP Input.dispatchMouseEvent, never page-eval, so it works on Trusted-Types pages (accounts.google.com) that refuse Runtime.evaluate and our tabs.eval. Resolves the node through the DOM domain (querySelector for --selector, or the smallest text-matching candidate for --text), scrolls it into view, takes its center from the content quads, and dispatches move → press → release.
  'tabs.click': async ({ id, selector, text }) => {
    const tabId = requireTabId(id);
    if (!selector && !text) {
      throw new Error('click needs a selector or text');
    }
    const target = { tabId };
    await dbgAttach(target);
    try {
      await dbgSend(target, 'DOM.enable', {});
      const { root } = await dbgSend(target, 'DOM.getDocument', { depth: 0 });
      let nodeId;
      if (selector) {
        ({ nodeId } = await dbgSend(target, 'DOM.querySelector', {
          nodeId: root.nodeId,
          selector,
        }));
        if (!nodeId) throw new Error(`selector not found: ${selector}`);
      } else {
        const { nodeIds } = await dbgSend(target, 'DOM.querySelectorAll', {
          nodeId: root.nodeId,
          selector: 'a,button,div,li,span,[role=button],[role=link]',
        });
        const needle = text.toLowerCase();
        let best = 0;
        let bestLen = Infinity;
        for (const candidate of nodeIds || []) {
          let html;
          try {
            ({ outerHTML: html } = await dbgSend(target, 'DOM.getOuterHTML', {
              nodeId: candidate,
            }));
          } catch (_) {
            continue;
          }
          const hay = stripTags(html).toLowerCase();
          if (hay.includes(needle) && hay.length < bestLen) {
            best = candidate;
            bestLen = hay.length;
          }
        }
        if (!best) throw new Error(`no element matching text: ${text}`);
        nodeId = best;
      }
      await dbgSend(target, 'DOM.scrollIntoViewIfNeeded', { nodeId });
      const { x, y } = await centerOf(target, nodeId);
      const { node } = await dbgSend(target, 'DOM.describeNode', { nodeId });
      await dbgSend(target, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await dbgSend(target, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      await dbgSend(target, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      });
      let label = '';
      try {
        const { outerHTML } = await dbgSend(target, 'DOM.getOuterHTML', { nodeId });
        label = stripTags(outerHTML).replace(/\s+/g, ' ').trim().slice(0, 200);
      } catch (_) {}
      return {
        id: tabId,
        tag: (node?.localName || node?.nodeName || '').toLowerCase(),
        text: label,
        x,
        y,
      };
    } finally {
      await dbgDetach(target);
    }
  },

  'tabs.wait': async ({ id, timeout }) => {
    const tabId = requireTabId(id);
    const ms = Number(timeout) > 0 ? Number(timeout) * 1000 : 30000;
    const current = await chrome.tabs.get(tabId);
    if (current.status === 'complete') return { id: tabId, status: 'complete' };
    const status = await new Promise((resolve) => {
      let settled = false;
      const done = (s) => {
        if (settled) return;
        settled = true;
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        resolve(s);
      };
      const listener = (tid, info) => {
        if (tid === tabId && info.status === 'complete') done('complete');
      };
      chrome.tabs.onUpdated.addListener(listener);
      const timer = setTimeout(() => done('timeout'), ms);
    });
    return { id: tabId, status };
  },

  'tabs.eval': async ({ id, code }) => {
    const tabId = requireTabId(id);
    if (typeof code !== 'string' || code === '') {
      throw new Error('eval needs code to run');
    }
    const [injection = {}] = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      args: [code],
      func: evalInPage,
    });
    if (injection.error) {
      throw new Error(injection.error);
    }
    return { id: tabId, result: injection.result ?? null };
  },

  'windows.list': async () => {
    const windows = await chrome.windows.getAll({ populate: true });
    return windows.map((w) => ({
      id: w.id,
      focused: !!w.focused,
      tabCount: w.tabs ? w.tabs.length : 0,
    }));
  },
};

function requireTabId(id) {
  const n = Number(id);
  if (!Number.isInteger(n)) {
    throw new Error(`invalid tab id: ${id}`);
  }
  return n;
}

// chrome.debugger, promise-wrapped. Used only by tabs.screenshot's native-clip
// path (CDP Page.captureScreenshot). detach never rejects so it's safe in finally.

function dbgAttach(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

function dbgDetach(target) {
  return new Promise((resolve) => {
    chrome.debugger.detach(target, () => {
      void chrome.runtime.lastError;
      resolve();
    });
  });
}

function dbgSend(target, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(target, method, params || {}, (result) => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve(result);
    });
  });
}

// Center point of a node in viewport CSS pixels. Prefers DOM.getContentQuads
// (the rendered fragment, handling wrapped/transformed boxes) and falls back to
// the border box of DOM.getBoxModel.
async function centerOf(target, nodeId) {
  try {
    const { quads } = await dbgSend(target, 'DOM.getContentQuads', { nodeId });
    if (quads && quads.length) {
      const q = quads[0];
      return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
    }
  } catch (_) {}
  const { model } = await dbgSend(target, 'DOM.getBoxModel', { nodeId });
  const q = model.border;
  return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
}

// Crude tag stripper for matching/printing element text without page-eval.
function stripTags(html) {
  return (html || '').replace(/<[^>]*>/g, ' ');
}

// Runs in the page. Returns the visible text of the document, preferring the
// <body> and collapsing whitespace so the CLI gets something readable.
function extractReadableText() {
  const root = document.body || document.documentElement;
  if (!root) return '';
  const text = root.innerText || root.textContent || '';
  return text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Runs in the page's main world. Evaluates `code` as an expression (falling
// back to statement execution) and returns it wrapped so the caller can tell
// a thrown error from a value; the result must survive structured cloning.
function evalInPage(code) {
  try {
    let value;
    try {
      value = (0, eval)(`(${code})`);
    } catch (_) {
      value = (0, eval)(code);
    }
    return { result: value === undefined ? null : value };
  } catch (e) {
    return { error: e?.message || String(e) };
  }
}

// --- Init ---

connect();
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
