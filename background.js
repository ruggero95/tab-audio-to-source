// Pages with a standard media element play straight to the chosen output, so Chrome keeps video in sync
// with the device latency. Other pages fall back to tab capture in the offscreen document.

const OFFSCREEN_URL = 'offscreen.html';
const MIC_URL = chrome.runtime.getURL('mic.html');
// Stays below the service worker idle timeout while the page waits for the microphone prompt.
const PERMISSION_TIMEOUT_MS = 20000;

let creatingOffscreen = null;
const mutedTabs = new Set();
const directRoutes = new Map();

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
    case 'badge':
      await setBadge(message.routes || []);
      return { ok: true };
    case 'routes-changed':
      await notifyRoutes(withDirect(message.routes || []));
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

  const tab = await chrome.tabs.get(tabId);
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tabId, { active: true });

  if (await startDirectRoute(tabId, deviceId)) {
    await chrome.storage.session.remove('lastError').catch(() => {});
    const routes = await allRoutes();
    await setBadge(routes);
    return { ok: true, routes };
  }

  await delay(150);

  let streamId;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
  } catch (error) {
    const message = error?.message || 'Cattura non avviata.';
    await rememberFailure(message);
    throw new Error(message);
  }

  await ensureOffscreen();
  const levels = await readLevels();
  const result = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'start',
    tabId,
    streamId,
    deviceId,
    volume: levels.volume,
    muted: levels.muted
  });
  const routes = withDirect(result?.routes || []);
  if (!result?.ok) {
    const message = result?.error || 'Riproduzione non riuscita';
    await rememberFailure(message);
    return { ok: false, error: message, routes };
  }

  await chrome.storage.session.remove('lastError').catch(() => {});
  await setBadge(routes);
  return { ...result, routes };
}

async function startDirectRoute(tabId, deviceId) {
  const label = await deviceLabel(deviceId);
  if (deviceId !== 'default' && !label) return false;

  try {
    const lookup = await withTimeout(
      runInPage(tabId, findPageSink, [label, deviceId === 'default', true, true]),
      PERMISSION_TIMEOUT_MS
    );
    if (lookup?.status !== 'ok') return false;

    await stopCapture(tabId);
    const applied = await runInPage(tabId, applyPageSink, [lookup.sinkId]);
    if (applied?.status !== 'ok') {
      await runInPage(tabId, clearPageSink, []).catch(() => {});
      return false;
    }
  } catch (error) {
    console.warn('Uscita diretta non disponibile, uso la cattura.', error);
    return false;
  }

  directRoutes.set(tabId, { deviceId, label });
  await persistDirectRoutes();
  return true;
}

async function moveRoute({ tabId, deviceId }) {
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new Error('Scegli un dispositivo di uscita.');
  }

  if (directRoutes.has(tabId)) {
    const label = await deviceLabel(deviceId);
    const lookup = await runInPage(tabId, findPageSink, [label, deviceId === 'default', false, false])
      .catch(() => null);
    if (lookup?.status !== 'ok') {
      throw new Error('Questa pagina non vede l\'uscita scelta. Premi Ripristina e inoltra di nuovo.');
    }
    const applied = await runInPage(tabId, applyPageSink, [lookup.sinkId]).catch(() => null);
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
  if (directRoutes.has(tabId)) await stopDirect(tabId);
  else await stopCapture(tabId);
  const routes = await allRoutes();
  await setBadge(routes);
  return { ok: true, routes };
}

async function stopAll() {
  for (const tabId of [...directRoutes.keys()]) await stopDirect(tabId);
  if (await hasOffscreen()) {
    await chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop-all' }).catch(() => {});
  }
  const routes = await allRoutes();
  await setBadge(routes);
  return { ok: true, routes };
}

async function stopDirect(tabId, { reset = true } = {}) {
  directRoutes.delete(tabId);
  await persistDirectRoutes();
  if (reset) await runInPage(tabId, clearPageSink, []).catch(() => {});
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
    if (lookup?.status === 'ok') {
      const applied = await runInPage(tabId, applyPageSink, [lookup.sinkId]);
      if (applied?.status === 'ok') return;
    }
  } catch {
    // The page can no longer be scripted, so the route is dropped below.
  }
  await stopDirect(tabId, { reset: false });
  await notifyRoutes(await allRoutes());
}

async function deviceLabel(deviceId) {
  if (deviceId === 'default') return '';
  const lists = [];
  try {
    await ensureOffscreen();
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'devices' });
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

function withTimeout(promise, ms) {
  return Promise.race([promise, delay(ms).then(() => null)]);
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

async function applyPageSink(sinkId) {
  const RESET = 'one-tab-audio-reset';
  let state = globalThis.__oneTabAudioSink;
  if (!state) {
    state = { sinkId };
    state.follow = (event) => {
      const element = event.target;
      if (element instanceof HTMLMediaElement && element.sinkId !== state.sinkId) {
        element.setSinkId(state.sinkId).catch(() => {});
      }
    };
    state.teardown = () => {
      document.removeEventListener('loadstart', state.follow, true);
      document.removeEventListener('play', state.follow, true);
      if (globalThis.__oneTabAudioSink === state) delete globalThis.__oneTabAudioSink;
    };
    document.addEventListener('loadstart', state.follow, true);
    document.addEventListener('play', state.follow, true);
    document.addEventListener(RESET, state.teardown, { once: true });
    globalThis.__oneTabAudioSink = state;
  }
  state.sinkId = sinkId;
  document.documentElement.dataset.oneTabAudio = '1';

  const elements = [...document.querySelectorAll('video, audio')];
  const results = await Promise.allSettled(elements.map((element) => element.setSinkId(sinkId)));
  if (elements.length && results.every((result) => result.status === 'rejected')) return { status: 'failed' };
  return { status: 'ok' };
}

async function clearPageSink() {
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
  return routes;
}

async function captureRoutes() {
  if (!(await hasOffscreen())) return [];
  try {
    const result = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'status' });
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
    const result = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'status' });
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
