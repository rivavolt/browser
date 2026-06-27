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

  // Reads the page's visible text via CDP Runtime.evaluate rather than
  // chrome.scripting, so it works on any background tab. Content-script
  // injection needs a runtime-granted host permission that Chrome withholds
  // from an externally-installed extension (everything but the active tab
  // errors "manifest must request permission to access the respective host");
  // the debugger transport only needs the already-granted debugger permission.
  'tabs.content': async ({ id }) => {
    const tabId = requireTabId(id);
    return withDebugger({ tabId }, async () => {
      const text = await dbgEval({ tabId }, `(${extractReadableText})()`);
      return { id: tabId, text: text ?? '' };
    });
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
    return withDebugger(target, async () => {
      const params = { format: 'png', captureBeyondViewport: true };
      if (selector) {
        const { root } = await dbgSend(target, 'DOM.getDocument', { depth: 0 });
        const { nodeId } = await dbgSend(target, 'DOM.querySelector', {
          nodeId: root.nodeId,
          selector,
        });
        if (!nodeId) throw new Error(`selector not found: ${selector}`);
        await dbgSend(target, 'DOM.scrollIntoViewIfNeeded', { nodeId });
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
        // Full page. A manual clip sized from getLayoutMetrics tiled the
        // viewport on SPA pages (takeout.google.com) whose document height is
        // far larger than the painted content; captureBeyondViewport with no
        // clip is the documented way to get the whole scrollable page and
        // paints it once, so let Chrome size it.
      }
      const { data } = await dbgSend(target, 'Page.captureScreenshot', params);
      return { id: tabId, dataUrl: `data:image/png;base64,${data}` };
    });
  },

  // Clicks with a real mouse via CDP Input.dispatchMouseEvent, never page-eval,
  // so it works on Trusted-Types pages (accounts/takeout.google.com) that
  // refuse Runtime.evaluate and our tabs.eval. Resolves a point three ways:
  // explicit --at x,y (viewport CSS px, no DOM lookup); a CSS --selector
  // (--nth picks among matches); or the smallest --text-matching candidate.
  // For element targets it scrolls into view, then takes the center from the
  // content quads, and dispatches move → press → release.
  'tabs.click': async ({ id, selector, text, nth, x: atX, y: atY }) => {
    const tabId = requireTabId(id);
    const hasAt = atX !== undefined && atX !== null && atY !== undefined && atY !== null;
    if (!selector && !text && !hasAt) {
      throw new Error('click needs a selector, text, or x/y');
    }
    const target = { tabId };
    return withDebugger(target, async () => {
      let x;
      let y;
      let tag = '';
      let label = '';
      if (hasAt) {
        x = Number(atX);
        y = Number(atY);
        if (!Number.isFinite(x) || !Number.isFinite(y)) {
          throw new Error(`invalid click coordinates: ${atX},${atY}`);
        }
      } else {
        await dbgSend(target, 'DOM.enable', {});
        const { root } = await dbgSend(target, 'DOM.getDocument', { depth: 0 });
        let nodeId;
        if (selector) {
          const { nodeIds } = await dbgSend(target, 'DOM.querySelectorAll', {
            nodeId: root.nodeId,
            selector,
          });
          const matches = nodeIds || [];
          if (!matches.length) throw new Error(`selector not found: ${selector}`);
          const i = Number(nth) || 0;
          if (i < 0 || i >= matches.length) {
            throw new Error(`--nth ${i} out of range (${matches.length} matches for ${selector})`);
          }
          nodeId = matches[i];
        } else {
          const { nodeIds } = await dbgSend(target, 'DOM.querySelectorAll', {
            nodeId: root.nodeId,
            selector: 'a,button,div,li,span,[role=button],[role=link]',
          });
          const needle = text.toLowerCase();
          const hits = [];
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
            if (hay.includes(needle)) hits.push({ candidate, len: hay.length });
          }
          if (!hits.length) throw new Error(`no element matching text: ${text}`);
          // Smallest matching element first, then --nth among equally-deep hits
          // so repeated labels (every "Multiple formats" row) are addressable.
          hits.sort((a, b) => a.len - b.len);
          const i = Number(nth) || 0;
          if (i < 0 || i >= hits.length) {
            throw new Error(`--nth ${i} out of range (${hits.length} matches for text: ${text})`);
          }
          nodeId = hits[i].candidate;
        }
        await dbgSend(target, 'DOM.scrollIntoViewIfNeeded', { nodeId });
        ({ x, y } = await centerOf(target, nodeId));
        const { node } = await dbgSend(target, 'DOM.describeNode', { nodeId });
        tag = (node?.localName || node?.nodeName || '').toLowerCase();
        try {
          const { outerHTML } = await dbgSend(target, 'DOM.getOuterHTML', { nodeId });
          label = stripTags(outerHTML).replace(/\s+/g, ' ').trim().slice(0, 200);
        } catch (_) {}
      }
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
      return { id: tabId, tag, text: label, x, y };
    });
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

  // Evaluates code in the page via CDP Runtime.evaluate instead of
  // chrome.scripting, for the same reason as tabs.content: scripting injection
  // is blocked on every non-active tab by withheld host permissions, while the
  // debugger transport is not. As a bonus this lands on Trusted-Types pages
  // that reject injected scripts (the case tabs.click was added for). Tried as
  // an expression first, falling back to statement execution, and any page
  // promise is awaited.
  'tabs.eval': async ({ id, code }) => {
    const tabId = requireTabId(id);
    if (typeof code !== 'string' || code === '') {
      throw new Error('eval needs code to run');
    }
    const target = { tabId };
    return withDebugger(target, async () => {
      let result;
      try {
        result = await dbgEval(target, `(${code})`);
      } catch (_) {
        result = await dbgEval(target, code);
      }
      return { id: tabId, result: result ?? null };
    });
  },

  // Runs code as a FUNCTION body via chrome.scripting.executeScript, not as a
  // string. This is the one way to inspect Trusted-Types pages (takeout/
  // accounts.google.com): they reject Runtime.evaluate of a string — which is
  // all tabs.eval can do — but a compiled, injected function is not a string
  // assignment so it runs, in the isolated content-script world by default
  // (world:'MAIN' for page-global access). scripting injection needs the
  // active-tab host grant Chrome withholds from an externally-installed
  // extension on background tabs, so the tab is activated first. The body may
  // `return` a value or be a bare expression (wrapped as `return (expr)` on a
  // parse error); the result must be JSON-serializable. args is passed through.
  'tabs.js': async ({ id, code, args, world }) => {
    const tabId = requireTabId(id);
    if (typeof code !== 'string' || code === '') {
      throw new Error('js needs code to run');
    }
    const tab = await chrome.tabs.get(tabId);
    if (!tab.active) {
      await chrome.tabs.update(tabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    const callArgs = Array.isArray(args) ? args : [];
    const w = world === 'MAIN' ? 'MAIN' : 'ISOLATED';
    const inject = (worldName) =>
      chrome.scripting.executeScript({
        target: { tabId },
        world: worldName,
        args: [code, callArgs],
        // Body first; on a syntax error (a bare expression like
        // `document.title`) retry it wrapped in a return.
        func: (src, a) => {
          let fn;
          try {
            fn = new Function('args', src);
          } catch (_) {
            fn = new Function('args', `return (${src});`);
          }
          return fn(a);
        },
      });
    let frames;
    try {
      frames = await inject(w);
    } catch (e) {
      throw new Error(`scripting.executeScript failed: ${e?.message || e}`);
    }
    const top = frames && frames[0];
    return { id: tabId, world: w, result: top ? top.result ?? null : null };
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

// chrome.debugger, promise-wrapped. detach never rejects so it's safe in finally.

function dbgAttachOnce(target) {
  return new Promise((resolve, reject) => {
    chrome.debugger.attach(target, '1.3', () => {
      const err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message));
      else resolve();
    });
  });
}

// Attach, recovering from a debugger left over by an aborted op: a request
// killed mid-flight (broken CLI pipe) or a lost attach race leaves the tab
// "already attached", after which every later op fails. On that one error we
// force a detach and retry once. A genuine second attacher (real DevTools open)
// re-errors and we surface it.
async function dbgAttach(target) {
  try {
    await dbgAttachOnce(target);
  } catch (e) {
    if (/already attached/i.test(e.message)) {
      await dbgDetach(target);
      await dbgAttachOnce(target);
    } else {
      throw e;
    }
  }
}

// Attach, run fn, always detach — even when fn throws. Centralizes the
// attach/try/finally every debugger-backed handler needs so none can leak an
// attached debugger on an error path.
async function withDebugger(target, fn) {
  await dbgAttach(target);
  try {
    return await fn();
  } finally {
    await dbgDetach(target);
  }
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

// Evaluates an expression in the page's main world over CDP and returns the
// value by structured value. Awaits a returned promise, and surfaces both a
// thrown page exception and a serialization failure as a rejection so callers
// (tabs.eval's expression/statement fallback, tabs.content) see a real error.
async function dbgEval(target, expression) {
  const { result, exceptionDetails } = await dbgSend(target, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (exceptionDetails) {
    throw new Error(
      exceptionDetails.exception?.description ||
        exceptionDetails.exception?.value ||
        exceptionDetails.text ||
        'evaluation failed',
    );
  }
  return result?.value;
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

// --- Init ---

connect();
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
