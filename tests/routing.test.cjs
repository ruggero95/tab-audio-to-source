const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
function stream() {
  const track = { readyState: 'live', stop() { this.readyState = 'ended'; },
    addEventListener(name, callback) { this[name] = callback; } };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}
function player(options = {}) {
  const messages = [], contexts = [], audios = [], timers = new Map();
  class Context {
    constructor({ sinkId } = {}) {
      this.sinkId = options.sink ? '' : (sinkId || ''); this.state = options.suspended ? 'suspended' : 'running';
      this.destination = {}; contexts.push(this);
    }
    async setSinkId(id) {
      if (options.sink) await options.sink();
      this.sinkId = id;
    }
    async resume() { if (options.resume) await options.resume(); this.state = 'running'; }
    async close() { this.state = 'closed'; }
    addEventListener() {}
    removeEventListener() {}
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createGain() { this.gainNode = { gain: {}, connect() {}, disconnect() {} }; return this.gainNode; }
    createMediaStreamDestination() { return { stream: stream() }; }
  }
  if (options.element) Context.prototype.setSinkId = undefined;
  class Audio {
    constructor() { audios.push(this); }
    async setSinkId() {}
    async play() { if (options.play) await options.play(); }
    pause() { this.paused = true; }
    remove() { this.removed = true; }
  }
  const sandbox = vm.createContext({
    AbortController, AudioContext: Context, Audio,
    console: { error() {}, warn() {} },
    setTimeout(fn, ms) { const key = {}; timers.set(key, { fn, ms }); return key; },
    clearTimeout(key) { timers.delete(key); },
    navigator: { mediaDevices: { getUserMedia: options.capture || (async () => stream()) } },
    document: { body: { append() {} } },
    chrome: { runtime: { onMessage: { addListener() {} },
      sendMessage(message) { messages.push(message); return Promise.resolve({ ok: true }); } } }
  });
  vm.runInContext(fs.readFileSync('offscreen.js', 'utf8'), sandbox);
  return { sandbox, messages, contexts, audios, timers,
    send: (message) => sandbox.onMessage(message),
    routes: () => JSON.parse(JSON.stringify(sandbox.currentRoutes())) };
}
const start = (p, tabId = 1) => p.send({ type: 'start', tabId, streamId: 'stream', deviceId: 'echo' });

test('a suspended context is pending until resume completes, and Stop releases it', async () => {
  const resume = deferred(), captured = stream();
  const p = player({ suspended: true, resume: () => resume.promise, capture: async () => captured });
  const opening = start(p);
  const rejected = assert.rejects(opening, /annullato/);
  await flush();
  assert.equal(p.routes()[0].state, 'starting');
  await p.send({ type: 'stop', tabId: 1 });
  await rejected;
  assert.equal(captured.track.readyState, 'ended');
  assert.equal(p.contexts[0].state, 'closed');
  resume.resolve();
  await flush();
  assert.deepEqual(p.routes(), []);
  assert.equal(p.messages.some((m) => m.type === 'mute-tab'), false);
});

test('a blocked sink times out and stops the capture, without opening a fallback', async () => {
  const captured = stream(), p = player({ sink: () => new Promise(() => {}), capture: async () => captured });
  const opening = start(p);
  const rejected = assert.rejects(opening, /non risponde/);
  await flush();
  [...p.timers.values()].find((t) => t.ms === 12000).fn();
  await rejected;
  assert.equal(captured.track.readyState, 'ended');
  assert.ok(p.contexts.every((context) => context.state === 'closed'));
  assert.deepEqual(p.routes(), []);
  assert.equal(p.audios.length, 0);
});

test('a capture arriving after cancellation is immediately released', async () => {
  const capture = deferred(), p = player({ capture: () => capture.promise });
  const opening = start(p);
  const rejected = assert.rejects(opening, /annullato/);
  await flush();
  await p.send({ type: 'stop', tabId: 1 });
  await rejected;
  const late = stream(); capture.resolve(late);
  await flush();
  assert.equal(late.track.readyState, 'ended');
  assert.equal(p.contexts.length, 0);
  assert.deepEqual(p.routes(), []);
});

test('a timed out getUserMedia also releases a late stream', async () => {
  const capture = deferred(), p = player({ capture: () => capture.promise });
  const opening = start(p);
  const rejected = assert.rejects(opening, /non risponde/);
  await flush();
  [...p.timers.values()].find((t) => t.ms === 12000).fn();
  await rejected;
  const late = stream(); capture.resolve(late);
  await flush();
  assert.equal(late.track.readyState, 'ended');
  assert.deepEqual(p.routes(), []);
});

test('Stop all releases active captures and an element player blocked in play()', async () => {
  const play = deferred(), captured = stream();
  const p = player({ element: true, play: () => play.promise, capture: async () => captured });
  const opening = start(p);
  const rejected = assert.rejects(opening, /annullato/);
  await flush();
  await p.send({ type: 'stop-all' });
  await rejected;
  assert.equal(captured.track.readyState, 'ended');
  assert.equal(p.audios[0].srcObject, null);
  assert.equal(p.audios[0].removed, true);
  assert.equal(p.contexts[0].state, 'closed');
  play.resolve(); await flush();
  assert.deepEqual(p.routes(), []);
});

test('a cancelled attempt cannot overwrite a subsequent successful attempt', async () => {
  const oldCapture = deferred(), newCapture = stream(); let calls = 0;
  const p = player({ capture: () => ++calls === 1 ? oldCapture.promise : Promise.resolve(newCapture) });
  const oldOpening = start(p);
  const rejected = assert.rejects(oldOpening, /annullato/);
  await flush();
  await start(p);
  await rejected;
  const late = stream(); oldCapture.resolve(late); await flush();
  assert.equal(late.track.readyState, 'ended');
  assert.equal(newCapture.track.readyState, 'live');
  assert.deepEqual(p.routes(), [{ tabId: 1, deviceId: 'echo', state: 'active' }]);
  await p.send({ type: 'stop-all' });
  assert.equal(newCapture.track.readyState, 'ended');
});

test('ending one capture leaves the other route active', async () => {
  const captures = [];
  const p = player({ capture: async () => { const s = stream(); captures.push(s); return s; } });
  await start(p, 1); await start(p, 2);
  captures[0].track.ended(); await flush();
  assert.deepEqual(p.routes(), [{ tabId: 2, deviceId: 'echo', state: 'active' }]);
  assert.equal(captures[1].track.readyState, 'live');
  await p.send({ type: 'stop-all' });
});

function background(options = {}) {
  const events = [], notifications = [], timers = new Map(); let exists = false;
  const session = { ...(options.session || {}) };
  const listener = { addListener() {} };
  const chrome = {
    runtime: { getURL: (path) => `chrome-extension://test/${path}`, onMessage: listener, onInstalled: listener,
      async getContexts() { return exists ? [{}] : []; },
      async sendMessage(message) {
        if (message.target === 'popup') { notifications.push(message); return; }
        events.push(message.type);
        if (options.message) { const result = options.message(message); if (result) return result; }
        if (message.type === 'devices') return { ok: true, devices: [{ deviceId: 'echo', label: 'Echo' }] };
        if (message.type === 'status') return { ok: true, routes: [] };
        return { ok: true, routes: [] };
      } },
    offscreen: { async createDocument() { events.push('create'); if (options.create) await options.create(); exists = true; },
      async closeDocument() { events.push('close'); exists = false; } },
    tabs: { onRemoved: listener, onReplaced: listener, onUpdated: listener,
      async query() { return []; }, async get(id) { return { id, windowId: 1, mutedInfo: { muted: true, reason: 'extension' } }; },
      async update(id, update) { events.push(update.muted === false ? 'unmute' : 'activate'); } },
    windows: { async update() {} },
    scripting: { async executeScript({ func, args }) {
      events.push(func.name);
      const result = options.page ? await options.page(func.name, args) : { status: 'no-media' };
      return [{ result }];
    } },
    tabCapture: { async getMediaStreamId() { events.push('stream-id'); return 'stream'; } },
    storage: { session: { async get(key) { return { [key]: session[key] }; },
      async set(data) { Object.assign(session, data); }, async remove(key) { delete session[key]; } },
      local: { async get() { return options.local || {}; } } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {} }
  };
  const sandbox = vm.createContext({ chrome, crypto: require('node:crypto').webcrypto, AbortController,
    console: { error() {}, warn() {} },
    setTimeout(fn, ms) {
      if (ms === 150) { queueMicrotask(fn); return {}; }
      const key = {}; timers.set(key, { fn, ms }); return key;
    }, clearTimeout(key) { timers.delete(key); } });
  vm.runInContext(fs.readFileSync('background.js', 'utf8'), sandbox);
  return { sandbox, events, session, notifications, timers,
    send: (message) => sandbox.handle(message) };
}

test('the offscreen consumer is ready before requesting an expiring stream ID', async () => {
  const creating = deferred(), b = background({ create: () => creating.promise });
  await flush();
  const opening = b.send({ type: 'start-route', tabId: 1, deviceId: 'echo' });
  await flush();
  assert.equal(b.events.includes('stream-id'), false);
  assert.equal((await b.send({ type: 'status' })).routes[0].state, 'starting');
  creating.resolve(); await opening;
  assert.ok(b.events.indexOf('create') < b.events.indexOf('stream-id'));
});

test('Stop during the page permission request prevents capture after permission arrives', async () => {
  const permission = deferred();
  const b = background({ page: (name) => name === 'findPageSink' ? permission.promise : { status: 'ok' } });
  await flush();
  const opening = b.send({ type: 'start-route', tabId: 1, deviceId: 'echo' });
  await flush();
  assert.equal((await b.send({ type: 'status' })).routes[0].state, 'starting');
  await b.send({ type: 'stop-route', tabId: 1 });
  permission.resolve({ status: 'ok', sinkId: 'page-echo' });
  await opening;
  assert.equal(b.events.includes('stream-id'), false);
  assert.equal(b.events.includes('applyPageSink'), false);
  assert.equal((await b.send({ type: 'status' })).routes.length, 0);
});

test('repeated starts while the page permission is pending do not request another capture', async () => {
  const permission = deferred();
  const b = background({ page: (name) => name === 'findPageSink' ? permission.promise : { status: 'ok' } });
  await flush();
  const opening = b.send({ type: 'start-route', tabId: 1, deviceId: 'echo' });
  await flush();
  await assert.rejects(b.send({ type: 'start-route', tabId: 1, deviceId: 'echo' }), /avvio/);
  await b.send({ type: 'stop-route', tabId: 1 });
  permission.resolve({ status: 'ok', sinkId: 'page-echo' }); await opening;
  assert.equal(b.events.filter((event) => event === 'findPageSink').length, 1);
});

test('Stop all destroys an unresponsive player and unmutes legacy captures', async () => {
  const b = background({ session: { mutedTabIds: [1] } });
  await flush();
  await b.send({ type: 'warm' });
  // refreshBadge at startup already clears legacy mutes with no offscreen document.
  vm.runInContext('mutedTabs.add(1)', b.sandbox);
  await b.send({ type: 'stop-all' });
  assert.ok(b.events.includes('close'));
  assert.ok(b.events.includes('unmute'));
  assert.equal((await b.send({ type: 'status' })).routes.length, 0);
});

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.listeners = {}; this.attrs = {};
    this.classList = { add() {}, toggle() {} }; this.value = ''; this.scrollTop = 0; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  setAttribute(key, value) { this.attrs[key] = value; }
  getAttribute(key) { return this.attrs[key]; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  get childElementCount() { return this.children.length; }
  get options() { return this.children; }
}
function popup() {
  const elements = new Map();
  const chrome = { runtime: { onMessage: { addListener() {} } } };
  const sandbox = vm.createContext({ chrome, URL,
    localStorage: { getItem() { return null; }, setItem() {} },
    document: { querySelector(id) { if (!elements.has(id)) elements.set(id, new Element('div')); return elements.get(id); },
      createElement: (tag) => new Element(tag) } });
  vm.runInContext(fs.readFileSync('popup.js', 'utf8'), sandbox);
  return { sandbox, elements, chrome };
}
function buttons(element) {
  return element.children.flatMap((child) => child.tagName === 'button' ? [child] : buttons(child));
}

test('pending routes keep both restore buttons usable while the popup is busy', () => {
  const p = popup();
  vm.runInContext(`state.busy = true; state.tabs = [{ id: 1, url: 'https://example.org', title: 'Audio' }];
    setRoutes([{ tabId: 1, deviceId: 'echo', state: 'starting' }]); render();`, p.sandbox);
  const restore = buttons(p.elements.get('#tabs')).find((button) => button.textContent === 'Ripristina');
  assert.ok(restore);
  assert.equal(restore.disabled, false);
  assert.equal(p.elements.get('#stop-all').disabled, false);
  vm.runInContext('setRoutes([]); render()', p.sandbox);
  assert.equal(p.elements.get('#stop-all').hidden, false);
});

test('the result of an interrupted start cannot replace the result of Stop', async () => {
  const p = popup(), opening = deferred();
  p.chrome.tabs = { async query() { return []; } };
  p.chrome.runtime.sendMessage = ({ type }) => type === 'start-route' ? opening.promise : Promise.resolve({ ok: true, routes: [] });
  const oldOperation = p.sandbox.run((op) => p.sandbox.callBackground({ type: 'start-route' }, op));
  await flush();
  await p.sandbox.run((op) => p.sandbox.callBackground({ type: 'stop-all' }, op), { interrupt: true });
  opening.resolve({ ok: true, routes: [{ tabId: 1, deviceId: 'echo' }] });
  await oldOperation;
  assert.equal(vm.runInContext('state.routes.size', p.sandbox), 0);
  assert.equal(vm.runInContext('state.busy', p.sandbox), false);
});

test('Restore during a direct output change prevents the route from returning later', async () => {
  const lookup = deferred();
  const b = background({ page: (name) => name === 'findPageSink' ? lookup.promise : { status: 'ok' } });
  await flush();
  vm.runInContext("directRoutes.set(1, { deviceId: 'old', label: 'Old' })", b.sandbox);
  const moving = b.send({ type: 'move-route', tabId: 1, deviceId: 'echo' });
  const rejected = assert.rejects(moving, /annullato/);
  await flush();
  await b.send({ type: 'stop-route', tabId: 1 });
  lookup.resolve({ status: 'ok', sinkId: 'page-echo' });
  await rejected;
  assert.equal(b.events.includes('applyPageSink'), false);
  assert.equal((await b.send({ type: 'status' })).routes.length, 0);
});

test('a late page sink application restores the current output instead of replacing a new route', async () => {
  const b = background(), oldSink = deferred(), listeners = new Map();
  const element = { sinkId: '', async setSinkId(sinkId) {
    if (sinkId === 'old') await oldSink.promise;
    this.sinkId = sinkId;
  } };
  const sandbox = vm.createContext({ Event, document: {
    documentElement: { dataset: {} }, querySelectorAll: () => [element],
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); }
  } });
  vm.runInContext(b.sandbox.applyPageSink.toString(), sandbox);
  vm.runInContext(b.sandbox.clearPageSink.toString(), sandbox);
  const oldApply = sandbox.applyPageSink('old', 'old-attempt');
  await flush();
  await sandbox.clearPageSink();
  await sandbox.applyPageSink('new', 'new-attempt');
  oldSink.resolve(); await oldApply;
  assert.equal(element.sinkId, 'new');
  await sandbox.clearPageSink('old-attempt');
  assert.equal(element.sinkId, 'new');
  await sandbox.clearPageSink();
  assert.equal(element.sinkId, '');
});


test('changing volume during capture acquisition keeps the latest value', async () => {
  const capture = deferred(), p = player({ capture: () => capture.promise });
  const opening = p.send({ type: 'start', tabId: 1, streamId: 'stream', deviceId: 'echo', volume: 0.05, muted: true });
  await flush();
  await p.send({ type: 'volume', volume: 1, muted: false });
  capture.resolve(stream()); await opening;
  assert.equal(p.contexts[0].gainNode.gain.value, 1);
  await p.send({ type: 'stop-all' });
});

test('changing volume while the audio device is starting updates the new gain', async () => {
  const resume = deferred(), p = player({ suspended: true, resume: () => resume.promise });
  const opening = p.send({ type: 'start', tabId: 1, streamId: 'stream', deviceId: 'echo', volume: 0.05, muted: false });
  await flush();
  await p.send({ type: 'volume', volume: 1, muted: false });
  resume.resolve(); await opening;
  assert.equal(p.contexts[0].gainNode.gain.value, 1);
  await p.send({ type: 'stop-all' });
});

test('100% gain preserves the input level and volume changes reach active captures', async () => {
  const p = player();
  await p.send({ type: 'start', tabId: 1, streamId: 'stream', deviceId: 'echo', volume: 1, muted: false });
  assert.equal(p.contexts[0].gainNode.gain.value, 1);
  await p.send({ type: 'volume', volume: 0.5, muted: false });
  assert.equal(p.contexts[0].gainNode.gain.value, 0.5);
  await p.send({ type: 'volume', volume: 1, muted: true });
  assert.equal(p.contexts[0].gainNode.gain.value, 0);
  await p.send({ type: 'volume', volume: 1, muted: false });
  assert.equal(p.contexts[0].gainNode.gain.value, 1);
  await p.send({ type: 'stop-all' });
});

test('direct players obey volume and mute, inherit levels on new media, and restore original settings', async () => {
  const b = background(), listeners = new Map();
  class Media {
    constructor(volume) { this.volume = volume; this.muted = false; this.sinkId = ''; }
    async setSinkId(sinkId) { this.sinkId = sinkId; }
  }
  const first = new Media(0.08), nodes = [first];
  const sandbox = vm.createContext({ Event, HTMLMediaElement: Media, document: {
    documentElement: { dataset: {} }, querySelectorAll: () => nodes,
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name, listener) { if (listeners.get(name) === listener) listeners.delete(name); },
    dispatchEvent(event) { listeners.get(event.type)?.(event); }
  } });
  for (const fn of ['applyPageSink', 'applyPageLevels', 'clearPageSink']) {
    vm.runInContext(b.sandbox[fn].toString(), sandbox);
  }
  await sandbox.applyPageSink('echo', 'attempt');
  sandbox.applyPageLevels(1.5, false, 'attempt');
  assert.equal(first.volume, 1);
  sandbox.applyPageLevels(0.4, true);
  assert.equal(first.volume, 0.4);
  assert.equal(first.muted, true);
  const next = new Media(0.7); nodes.push(next);
  listeners.get('play')({ target: next });
  assert.equal(next.volume, 0.4);
  assert.equal(next.muted, true);
  sandbox.applyPageLevels(1, false);
  assert.equal(first.muted, false);
  assert.equal(next.muted, false);
  await sandbox.clearPageSink();
  assert.equal(first.volume, 0.08);
  assert.equal(next.volume, 0.7);
  assert.equal(first.muted, false);
  assert.equal(next.muted, false);
});

test('volume commands reach direct players and captures from the same popup control', async () => {
  const levels = [], b = background({ page: (name, args) => {
    if (name === 'applyPageLevels') levels.push(args);
    return { status: 'ok' };
  } });
  await flush();
  await b.send({ type: 'warm' });
  vm.runInContext("directRoutes.set(1, { deviceId: 'echo', label: 'Echo' })", b.sandbox);
  await b.send({ type: 'volume', volume: 0.4, muted: true });
  assert.equal(levels.length, 1);
  assert.equal(levels[0][0], 0.4);
  assert.equal(levels[0][1], true);
  assert.ok(b.events.includes('volume'));
});

test('the slider reflects the 100% limit of direct players and the 150% boost for captures', () => {
  const p = popup();
  p.sandbox.showVolume(150);
  vm.runInContext("setRoutes([{ tabId: 1, deviceId: 'echo', mode: 'direct' }]); render()", p.sandbox);
  assert.equal(p.elements.get('#volume').max, '100');
  assert.equal(p.elements.get('#volume').value, '100');
  assert.match(p.elements.get('#volume-hint').textContent, /player/);
  vm.runInContext("setRoutes([{ tabId: 1, deviceId: 'echo', mode: 'capture' }]); render()", p.sandbox);
  assert.equal(p.elements.get('#volume').max, '150');
  assert.equal(p.elements.get('#volume').value, '150');
});


test('starting a direct route applies the saved volume and mute controls without capturing', async () => {
  const applied = [];
  const b = background({ local: { outputVolume: 1.5, outputMuted: false }, page: (name, args) => {
    if (name === 'findPageSink') return { status: 'ok', sinkId: 'page-echo' };
    if (name === 'applyPageLevels') applied.push(args);
    return { status: 'ok' };
  } });
  await flush();
  await b.send({ type: 'start-route', tabId: 1, deviceId: 'echo' });
  assert.equal(applied.length, 1);
  assert.equal(applied[0][0], 1.5);
  assert.equal(applied[0][1], false);
  assert.equal((await b.send({ type: 'status' })).routes[0].mode, 'direct');
  assert.equal(b.events.includes('stream-id'), false);
  await b.send({ type: 'stop-all' });
});
