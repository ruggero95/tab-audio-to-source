// Pages with a standard media element play straight to the chosen output, so Chrome keeps video in sync
// with the device latency. Other pages fall back to tab capture in the offscreen document.

const OFFSCREEN_URL = 'offscreen.html';
const MIC_URL = chrome.runtime.getURL('mic.html');
// Stays below the service worker idle timeout while the page waits for the microphone prompt.
const PERMISSION_TIMEOUT_MS = 20000;

let creatingOffscreen = null;
const mutedTabs = new Set();
const directRoutes = new Map();
const pendingStarts = new Map();

const restored = Promise.all([restoreMutedTabs(), restoreDirectRoutes()]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'background') return;

  restored
    .then(() => handle(message))
    .then(sendResponse)
    .catch((error) => {
      console.error(error);
      sendResponse({ ok: false, error: error?.message || 'Operazione non riuscita' });
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void restored.then(() => releaseTab(tabId));
});

chrome.tabs.onReplaced.addListener((_addedTabId, removedTabId) => {
  void restored.then(() => releaseTab(removedTabId));
});

chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (info.status !== 'complete') return;
  void restored.then(() => reapplyDirect(tabId));
});

chrome.runtime.onInstalled.addListener(() => {
  void setBadge([]);
  void closeLeftoverPlayerTabs();
  void resetPageSinks();
});

void restored.then(() => refreshBadge());
void closeLeftoverPlayerTabs();

async function handle(message) {
  switch (message.type) {
    case 'warm':
      await ensureOffscreen();
      return { ok: true };
    case 'open-mic':
      await openMic();
      return { ok: true };
    case 'status':
      return { ok: true, routes: await allRoutes() };
    case 'start-route':
      return startRoute(message);
    case 'move-route':
      return moveRoute(message);
    case 'stop-route':
      return stopRoute(message.tabId);
    case 'stop-all':
      return stopAll();
    case 'volume':
      return applyLevels(message.volume, message.muted);
    case 'badge':
      await setBadge(message.routes || []);
      return { ok: true };
    case 'routes-changed':
      await notifyRoutes(await allRoutes());
      return { ok: true };
    case 'mute-tab':
      await muteTab(message.tabId);
      return { ok: true };
    case 'unmute-tab':
      await unmuteTab(message.tabId);
      return { ok: true };
    default:
      throw new Error('Comando sconosciuto');
  }
}

async function startRoute({ tabId, deviceId }) {
  if (!Number.isInteger(tabId)) throw new Error('Tab non valida.');
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new Error('Scegli un dispositivo di uscita.');
  }
  if (directRoutes.has(tabId)) return moveRoute({ tabId, deviceId });

  if (pendingStarts.has(tabId)) throw new Error('Inoltro già in avvio. Premi Ripristina per annullarlo.');
  const attempt = { id: crypto.randomUUID(), deviceId, controller: new AbortController() };
  pendingStarts.set(tabId, attempt);
  const check = () => attempt.controller.signal.throwIfAborted();
  try {
    const existing = (await captureRoutes()).find((route) => route.tabId === tabId);
    check();
    if (existing) return await moveRoute({ tabId, deviceId });
    await notifyRoutes(await allRoutes());
    const tab = await chrome.tabs.get(tabId);
    check();
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
    check();

    if (await startDirectRoute(tabId, deviceId, attempt)) {
      check();
      await chrome.storage.session.remove('lastError').catch(() => {});
      return { ok: true, routes: await allRoutes() };
    }
    check();
    await delay(150);
    await ensureOffscreen();
    const levels = await readLevels();
    check();
    // Stream IDs expire quickly: prepare the consumer before requesting one.
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    check();
    const result = await chrome.runtime.sendMessage({
      target: 'offscreen', type: 'start', tabId, streamId, deviceId,
      volume: levels.volume, muted: levels.muted
    });
    check();
    if (!result?.ok) throw new Error(result?.error || 'Riproduzione non riuscita');
    await chrome.storage.session.remove('lastError').catch(() => {});
    return { ok: true, routes: withDirect(result.routes || []) };
  } catch (error) {
    if (attempt.controller.signal.aborted) return { ok: true, routes: await allRoutes() };
    await rememberFailure(error?.message || 'Inoltro non riuscito.');
    throw error;
  } finally {
    if (pendingStarts.get(tabId) === attempt) pendingStarts.delete(tabId);
    await notifyRoutes(await allRoutes());
  }
}

async function startDirectRoute(tabId, deviceId, attempt) {
  const label = await deviceLabel(deviceId);
  attempt.controller.signal.throwIfAborted();
  if (deviceId !== 'default' && !label) return false;

  try {
    const lookup = await withTimeout(
      runInPage(tabId, findPageSink, [label, deviceId === 'default', true, true]),
      PERMISSION_TIMEOUT_MS
    );
    attempt.controller.signal.throwIfAborted();
    if (lookup?.status !== 'ok') return false;

    await stopCapture(tabId);
    attempt.controller.signal.throwIfAborted();
    const applied = await withTimeout(runInPage(tabId, applyPageSink, [lookup.sinkId, attempt.id]), 8000);
    if (attempt.controller.signal.aborted) {
      await withTimeout(runInPage(tabId, clearPageSink, [attempt.id]).catch(() => {}), 2000);
      attempt.controller.signal.throwIfAborted();
    }
    if (applied?.status !== 'ok') {
      await withTimeout(runInPage(tabId, clearPageSink, [attempt.id]).catch(() => {}), 2000);
      return false;
    }
  } catch (error) {
    await withTimeout(runInPage(tabId, clearPageSink, [attempt.id]).catch(() => {}), 2000);
    attempt.controller.signal.throwIfAborted();
    console.warn('Uscita diretta non disponibile, uso la cattura.', error);
    return false;
  }

  const route = { deviceId, label };
  directRoutes.set(tabId, route);
  try {
    await persistDirectRoutes();
    const levels = await readLevels();
    attempt.controller.signal.throwIfAborted();
    const applied = await runInPage(tabId, applyPageLevels, [levels.volume, levels.muted, attempt.id]);
    attempt.controller.signal.throwIfAborted();
    if (applied?.status !== 'ok') throw new Error('Volume del player non disponibile. Ripristina e riprova.');
    return true;
  } catch (error) {
    if (directRoutes.get(tabId) === route) await stopDirect(tabId);
    throw error;
  }
}

async function moveRoute({ tabId, deviceId }) {
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new Error('Scegli un dispositivo di uscita.');
  }

  if (directRoutes.has(tabId)) {
    const previous = directRoutes.get(tabId);
    const check = () => {
      if (directRoutes.get(tabId) !== previous) throw new Error('Inoltro annullato.');
    };
    const label = await deviceLabel(deviceId);
    check();
    const lookup = await runInPage(tabId, findPageSink, [label, deviceId === 'default', false, false])
      .catch(() => null);
    check();
    if (lookup?.status !== 'ok') {
      throw new Error('Questa pagina non vede l\'uscita scelta. Premi Ripristina e inoltra di nuovo.');
    }
    const applied = await withTimeout(runInPage(tabId, applyPageSink, [lookup.sinkId]), 8000).catch(() => null);
    check();
    if (applied?.status !== 'ok') {
      throw new Error('Chrome non accetta questa uscita. Premi «Uscite» e selezionala di nuovo.');
    }
    directRoutes.set(tabId, { deviceId, label });
    await persistDirectRoutes();
  } else {
    const result = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'move', tabId, deviceId });
    if (!result?.ok) throw new Error(result?.error || 'Spostamento non riuscito');
  }

  const routes = await allRoutes();
  await setBadge(routes);
  return { ok: true, routes };
}

async function stopRoute(tabId) {
  cancelStart(tabId);
  await stopDirect(tabId);
  await stopCapture(tabId);
  const routes = await allRoutes();
  await setBadge(routes);
  return { ok: true, routes };
}

function cancelStart(tabId) {
  const attempt = pendingStarts.get(tabId);
  pendingStarts.delete(tabId);
  attempt?.controller.abort(new Error('Inoltro annullato.'));
}

async function stopAll() {
  const pending = [...pendingStarts.keys()];
  pending.forEach(cancelStart);
  for (const tabId of pending) await withTimeout(runInPage(tabId, clearPageSink, []).catch(() => {}), 2000);
  for (const tabId of [...directRoutes.keys()]) await stopDirect(tabId);
  if (await hasOffscreen()) {
    // Closing the document also releases captures left by an unresponsive/older player.
    await chrome.offscreen.closeDocument();
  }
  await unmuteAll();
  const routes = await allRoutes();
  await notifyRoutes(routes);
  return { ok: true, routes };
}

async function stopDirect(tabId, { reset = true } = {}) {
  directRoutes.delete(tabId);
  await persistDirectRoutes();
  if (reset) await withTimeout(runInPage(tabId, clearPageSink, []).catch(() => {}), 2000);
}

async function stopCapture(tabId) {
  await unmuteTab(tabId);
  if (!(await hasOffscreen())) return;
  await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop', tabId }).catch(() => {});
}

async function reapplyDirect(tabId) {
  const route = directRoutes.get(tabId);
  if (!route) return;
  try {
    const lookup = await runInPage(tabId, findPageSink, [route.label, route.deviceId === 'default', false, false]);
    if (directRoutes.get(tabId) !== route) return;
    if (lookup?.status === 'ok') {
      const applied = await runInPage(tabId, applyPageSink, [lookup.sinkId]);
      if (applied?.status === 'ok' && directRoutes.get(tabId) === route) {
        const levels = await readLevels();
        if (directRoutes.get(tabId) !== route) return;
        await runInPage(tabId, applyPageLevels, [levels.volume, levels.muted]);
        return;
      }
    }
  } catch {
    // The page can no longer be scripted, so the route is dropped below.
  }
  if (directRoutes.get(tabId) !== route) return;
  await stopDirect(tabId, { reset: false });
  await notifyRoutes(await allRoutes());
}

async function deviceLabel(deviceId) {
  if (deviceId === 'default') return '';
  const lists = [];
  try {
    await ensureOffscreen();
    const response = await withTimeout(chrome.runtime.sendMessage({ target: 'offscreen', type: 'devices' }), 2000);
    if (response?.ok) lists.push(response.devices || []);
  } catch {
    // Stored names below are enough to match the device.
  }
  const stored = await chrome.storage.local.get('outputDevices').catch(() => ({}));
  lists.push(Array.isArray(stored.outputDevices) ? stored.outputDevices : []);
  for (const list of lists) {
    const match = list.find((device) => device?.deviceId === deviceId && device.label?.trim());
    if (match) return match.label.trim();
  }
  return '';
}

async function runInPage(tabId, func, args) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    func,
    args
  });
  return result?.result;
}

async function withTimeout(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), ms);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

async function resetPageSinks() {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  await Promise.all(tabs
    .filter((tab) => /^(https?|file):/i.test(tab.url || ''))
    .map((tab) => runInPage(tab.id, clearPageSink, []).catch(() => {})));
}

// The functions below run inside the page, so they must not use anything from this file.

async function findPageSink(label, useDefault, requireMedia, askPermission) {
  if (typeof HTMLMediaElement.prototype.setSinkId !== 'function') return { status: 'unsupported' };
  if (requireMedia && !document.querySelector('video, audio')) return { status: 'no-media' };
  if (useDefault) return { status: 'ok', sinkId: '' };

  let found = await lookup();
  if (found.status === 'needs-permission' && askPermission) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((track) => track.stop());
    } catch {
      return { status: 'denied' };
    }
    found = await lookup();
  }
  return found;

  async function lookup() {
    const outputs = (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === 'audiooutput');
    if (!outputs.some((device) => device.label)) return { status: 'needs-permission' };
    const match = outputs.find((device) => device.deviceId !== 'default'
      && device.deviceId !== 'communications'
      && device.label.trim() === label);
    return match ? { status: 'ok', sinkId: match.deviceId } : { status: 'not-found' };
  }
}

async function applyPageSink(sinkId, ownerId) {
  const RESET = 'one-tab-audio-reset';
  let state = globalThis.__oneTabAudioSink;
  if (!state) {
    state = { sinkId, previousLevels: new Map() };
    state.applyLevels = (element) => {
      if (!state.levels) return;
      if (!state.previousLevels.has(element)) {
        state.previousLevels.set(element, { volume: element.volume, muted: element.muted });
      }
      element.volume = state.levels.volume;
      element.muted = state.levels.muted;
    };
    state.follow = (event) => {
      const element = event.target;
      if (element instanceof HTMLMediaElement && element.sinkId !== state.sinkId) {
        element.setSinkId(state.sinkId).catch(() => {});
      }
      if (element instanceof HTMLMediaElement) state.applyLevels(element);
    };
    state.teardown = () => {
      document.removeEventListener('loadstart', state.follow, true);
      document.removeEventListener('play', state.follow, true);
      for (const [element, previous] of state.previousLevels) {
        element.volume = previous.volume;
        element.muted = previous.muted;
      }
      state.previousLevels.clear();
      if (globalThis.__oneTabAudioSink === state) delete globalThis.__oneTabAudioSink;
    };
    document.addEventListener('loadstart', state.follow, true);
    document.addEventListener('play', state.follow, true);
    document.addEventListener(RESET, state.teardown, { once: true });
    globalThis.__oneTabAudioSink = state;
  }
  state.sinkId = sinkId;
  if (ownerId) state.ownerId = ownerId;
  document.documentElement.dataset.oneTabAudio = '1';

  const elements = [...document.querySelectorAll('video, audio')];
  const results = await Promise.allSettled(elements.map((element) => element.setSinkId(sinkId)));
  if (globalThis.__oneTabAudioSink !== state) {
    const currentSink = globalThis.__oneTabAudioSink?.sinkId || '';
    await Promise.allSettled(elements.map((element) => element.setSinkId(currentSink)));
    return { status: 'cancelled' };
  }
  if (elements.length && results.every((result) => result.status === 'rejected')) return { status: 'failed' };
  return { status: 'ok' };
}

function applyPageLevels(volume, muted, ownerId) {
  const state = globalThis.__oneTabAudioSink;
  if (!state || (ownerId && state.ownerId !== ownerId)) return { status: 'cancelled' };
  if (!Number.isFinite(volume)) return { status: 'failed' };
  // HTMLMediaElement can reach 100%; boost above 100% is available on captures.
  state.levels = { volume: Math.min(1, Math.max(0, volume)), muted: muted === true };
  for (const element of document.querySelectorAll('video, audio')) state.applyLevels(element);
  return { status: 'ok' };
}

async function clearPageSink(ownerId) {
  if (ownerId && globalThis.__oneTabAudioSink?.ownerId !== ownerId) return { status: 'ok' };
  if (document.documentElement.dataset.oneTabAudio !== '1') return { status: 'ok' };
  document.dispatchEvent(new Event('one-tab-audio-reset'));
  delete document.documentElement.dataset.oneTabAudio;
  await Promise.allSettled([...document.querySelectorAll('video, audio')]
    .filter((element) => element.sinkId)
    .map((element) => element.setSinkId('')));
  return { status: 'ok' };
}

function withDirect(captureRoutes) {
  const routes = captureRoutes
    .filter((route) => !directRoutes.has(route.tabId))
    .map((route) => ({ ...route, mode: 'capture' }));
  for (const [tabId, route] of directRoutes) {
    routes.push({ tabId, deviceId: route.deviceId, mode: 'direct' });
  }
  for (const [tabId, attempt] of pendingStarts) {
    if (!routes.some((route) => route.tabId === tabId)) {
      routes.push({ tabId, deviceId: attempt.deviceId, state: 'starting' });
    }
  }
  return routes;
}

async function captureRoutes() {
  if (!(await hasOffscreen())) return [];
  try {
    const result = await withTimeout(chrome.runtime.sendMessage({ target: 'offscreen', type: 'status' }), 2000);
    return result?.routes || [];
  } catch {
    return [];
  }
}

async function allRoutes() {
  return withDirect(await captureRoutes());
}

async function notifyRoutes(routes) {
  await setBadge(routes);
  void chrome.runtime.sendMessage({ target: 'popup', type: 'routes', routes }).catch(() => {});
}

async function applyLevels(volume, muted) {
  const results = await Promise.allSettled([...directRoutes.keys()].map((tabId) =>
    runInPage(tabId, applyPageLevels, [volume, muted])
  ));
  if (await hasOffscreen()) {
    const result = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'volume', volume, muted });
    if (!result?.ok) throw new Error(result?.error || 'Volume non aggiornato.');
  }
  const failure = results.find((result) => result.status === 'rejected' || result.value?.status !== 'ok');
  if (failure) throw new Error('Non riesco a regolare il volume nella pagina. Ripristina e inoltra di nuovo.');
  return { ok: true };
}

async function readLevels() {
  try {
    const stored = await chrome.storage.local.get(['outputVolume', 'outputMuted']);
    return {
      volume: typeof stored.outputVolume === 'number' ? stored.outputVolume : 1,
      muted: stored.outputMuted === true
    };
  } catch {
    return { volume: 1, muted: false };
  }
}

async function rememberFailure(message) {
  await chrome.storage.session.set({ lastError: message }).catch(() => {});
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openMic() {
  const tabs = await chrome.tabs.query({ url: MIC_URL });
  if (tabs[0]) {
    await chrome.windows.update(tabs[0].windowId, { focused: true });
    await chrome.tabs.update(tabs[0].id, { active: true, url: MIC_URL });
    return;
  }
  await chrome.tabs.create({ url: MIC_URL, active: true });
}

async function closeLeftoverPlayerTabs() {
  const tabs = await chrome.tabs.query({ url: 'https://example.com/*' });
  const ids = tabs.filter((tab) => (tab.url || '').includes('one-tab-audio')).map((tab) => tab.id);
  if (ids.length) await chrome.tabs.remove(ids);
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;

  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['USER_MEDIA', 'AUDIO_PLAYBACK'],
        justification: 'Cattura l\'audio di una tab e lo inoltra all\'altoparlante scelto.'
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }

  try {
    await creatingOffscreen;
  } catch (error) {
    if (!(await hasOffscreen())) throw error;
  }
}

async function releaseTab(tabId) {
  cancelStart(tabId);
  if (directRoutes.has(tabId)) await stopDirect(tabId, { reset: false });
  await unmuteTab(tabId);
  if (!(await hasOffscreen())) {
    await setBadge(withDirect([]));
    return;
  }

  try {
    const result = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop', tabId });
    await setBadge(withDirect(result?.routes || []));
  } catch {
    await setBadge(withDirect([]));
  }
}

async function refreshBadge() {
  if (!(await hasOffscreen())) {
    await unmuteAll();
    await setBadge(withDirect([]));
    return;
  }

  try {
    const result = await withTimeout(chrome.runtime.sendMessage({ target: 'offscreen', type: 'status' }), 2000);
    const routes = result?.routes || [];
    const live = new Set(routes.map((route) => route.tabId));
    for (const tabId of [...mutedTabs]) {
      if (!live.has(tabId)) await unmuteTab(tabId);
    }
    await setBadge(withDirect(routes));
  } catch {
    await setBadge(withDirect([]));
  }
}

async function restoreMutedTabs() {
  try {
    const stored = await chrome.storage.session.get('mutedTabIds');
    for (const tabId of stored.mutedTabIds || []) mutedTabs.add(tabId);
  } catch {
    // Storage is unavailable until the extension is reloaded with the new permission.
  }
}

async function restoreDirectRoutes() {
  try {
    const stored = await chrome.storage.session.get('directRoutes');
    for (const route of stored.directRoutes || []) {
      if (Number.isInteger(route?.tabId)) {
        directRoutes.set(route.tabId, { deviceId: route.deviceId, label: route.label || '' });
      }
    }
  } catch {
    // Without session storage the routes are rebuilt the next time a tab is forwarded.
  }
}

async function persistDirectRoutes() {
  const routes = [...directRoutes.entries()].map(([tabId, route]) => ({ tabId, ...route }));
  await chrome.storage.session.set({ directRoutes: routes }).catch(() => {});
}

async function muteTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || (tab.url || '').includes('one-tab-audio')) return;
  if (tab.mutedInfo?.muted && tab.mutedInfo.reason === 'user') return;
  if (!tab.mutedInfo?.muted) await chrome.tabs.update(tabId, { muted: true });
  mutedTabs.add(tabId);
  await persistMutedTabs();
}

async function unmuteTab(tabId) {
  if (!mutedTabs.has(tabId)) return;
  mutedTabs.delete(tabId);
  await persistMutedTabs();
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.mutedInfo?.muted || tab.mutedInfo.reason === 'user') return;
  await chrome.tabs.update(tabId, { muted: false });
}

async function unmuteAll() {
  for (const tabId of [...mutedTabs]) await unmuteTab(tabId);
}

async function persistMutedTabs() {
  await chrome.storage.session.set({ mutedTabIds: [...mutedTabs] }).catch(() => {});
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  return contexts.length > 0;
}

async function setBadge(routes) {
  await chrome.action.setBadgeText({ text: routes.length ? String(routes.length) : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#1f8f86' });
}
