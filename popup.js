const SHOW_ALL_KEY = 'showAll';

const deviceSelect = document.querySelector('#device');
const volumeInput = document.querySelector('#volume');
const volumeValue = document.querySelector('#volume-value');
const muteOutButton = document.querySelector('#mute-out');
const pickButton = document.querySelector('#pick');
const showAllInput = document.querySelector('#show-all');
const reloadButton = document.querySelector('#reload');
const stopAllButton = document.querySelector('#stop-all');
const errorBox = document.querySelector('#error');
const tabList = document.querySelector('#tabs');

const state = {
  tabs: [],
  routes: new Map(),
  synced: new Set(),
  currentWindowId: null,
  busy: false,
  showAll: localStorage.getItem(SHOW_ALL_KEY) === '1',
  playback: new Map(),
  toggling: null,
  token: 0
};

showAllInput.checked = state.showAll;

deviceSelect.addEventListener('change', () => {
  if (deviceSelect.value && chrome.storage?.local) {
    void chrome.storage.local.set({
      outputDeviceId: deviceSelect.value,
      outputDeviceLabel: deviceSelect.selectedOptions[0]?.textContent || ''
    });
  }
  render();
});

pickButton.addEventListener('click', () => {
  void refreshOutputs();
});

volumeInput.addEventListener('input', () => {
  showVolume(Number(volumeInput.value));
  void persistLevels();
});

muteOutButton.addEventListener('click', () => {
  const muted = muteOutButton.getAttribute('aria-pressed') !== 'true';
  muteOutButton.setAttribute('aria-pressed', muted ? 'true' : 'false');
  muteOutButton.textContent = muted ? 'Riattiva' : 'Silenzia';
  void persistLevels();
});

showAllInput.addEventListener('change', () => {
  state.showAll = showAllInput.checked;
  localStorage.setItem(SHOW_ALL_KEY, state.showAll ? '1' : '0');
  render();
});

reloadButton.addEventListener('click', () => {
  void reload();
});

stopAllButton.addEventListener('click', () => {
  if (state.busy) return;
  void run(() => callBackground({ type: 'stop-all' }));
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.target !== 'popup' || message.type !== 'routes') return;
  setRoutes(message.routes || []);
  render();
});

void init();

async function init() {
  if (!globalThis.chrome?.tabs || !chrome.runtime?.id) return;
  chrome.storage?.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!changes.outputDeviceId && !changes.outputDeviceLabel && !changes.outputDevices) return;
    void loadDevices().then(render).catch(() => {});
  });
  const levels = chrome.storage?.local
    ? await chrome.storage.local.get(['outputVolume', 'outputMuted'])
    : {};
  if (typeof levels.outputVolume === 'number') showVolume(Math.round(levels.outputVolume * 100));
  if (levels.outputMuted === true) {
    muteOutButton.setAttribute('aria-pressed', 'true');
    muteOutButton.textContent = 'Riattiva';
  }
  void callBackground({ type: 'warm' }).catch(() => {});
  await reload();
  const stored = await chrome.storage.session.get('lastError').catch(() => ({}));
  if (stored.lastError) {
    showError(humanize(stored.lastError));
    await chrome.storage.session.remove('lastError').catch(() => {});
  }
}

async function reload() {
  const token = ++state.token;
  clearError();
  try {
    const [listed, currentWindow] = await Promise.all([
      chrome.tabs.query({}),
      chrome.windows.getCurrent(),
      loadRoutes()
    ]);
    if (token !== state.token) return;
    state.currentWindowId = currentWindow.id;
    state.tabs = listed.filter((tab) => capturableUrl(tab.url || ''));
    reconcilePlayback();
    await loadDevices();
    if (token !== state.token) return;
    void callBackground({ type: 'badge', routes: routesArray() }).catch(() => {});
    render();
  } catch (error) {
    if (token !== state.token) return;
    showError(humanize(error.message));
  }
}

async function loadRoutes() {
  await callBackground({ type: 'status' }).catch(() => {});
}

function setRoutes(routes) {
  state.routes = new Map(routes.map((route) => [route.tabId, route.deviceId]));
  state.synced = new Set(routes.filter((route) => route.mode === 'direct').map((route) => route.tabId));
}

async function loadDevices() {
  const stored = chrome.storage?.local
    ? await chrome.storage.local.get(['outputDeviceId', 'outputDeviceLabel', 'outputDevices'])
    : {};
  const outputs = mergeOutputs(await collectOutputs(), stored.outputDevices);
  const rememberedId = stored.outputDeviceId || '';
  const rememberedLabel = stored.outputDeviceLabel || '';
  const previous = deviceSelect.value || rememberedId || matchLabel(outputs, rememberedLabel);

  deviceSelect.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = outputs.length ? 'Seleziona un\'uscita…' : 'Nessuna uscita';
  deviceSelect.append(placeholder);

  const seen = new Set();
  for (const device of outputs) {
    if (!device?.deviceId || seen.has(device.deviceId)) continue;
    seen.add(device.deviceId);
    deviceSelect.append(deviceOption(device));
  }

  if (previous && [...deviceSelect.options].some((option) => option.value === previous)) {
    deviceSelect.value = previous;
  }
}

async function collectOutputs() {
  const lists = [];
  if (navigator.mediaDevices?.enumerateDevices) {
    lists.push(await mapOutputs(await navigator.mediaDevices.enumerateDevices()));
  }
  try {
    await callBackground({ type: 'warm' });
    const response = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'devices' });
    if (response?.ok) lists.push(response.devices || []);
  } catch {
    // The offscreen document is created on the next attempt.
  }
  return lists.sort((left, right) => outputScore(right) - outputScore(left))[0] || [];
}

async function refreshOutputs() {
  clearError();
  try {
    await loadDevices();
    render();
  } catch (error) {
    showError(humanize(error.message));
  }
  chrome.runtime.sendMessage({ target: 'background', type: 'open-mic' }).catch(() => {});
}

function showVolume(percent) {
  const value = Math.min(150, Math.max(0, Math.round(percent)));
  volumeInput.value = String(value);
  volumeValue.textContent = `${value}%`;
  volumeInput.setAttribute('aria-valuenow', String(value));
}

function forwardedMuted() {
  return muteOutButton.getAttribute('aria-pressed') === 'true';
}

async function persistLevels() {
  const volume = Number(volumeInput.value) / 100;
  const muted = forwardedMuted();
  if (chrome.storage?.local) {
    await chrome.storage.local.set({ outputVolume: volume, outputMuted: muted });
  }
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'volume', volume, muted }).catch(() => {});
}

function mergeOutputs(live, stored) {
  const byId = new Map();
  for (const device of [...(Array.isArray(live) ? live : []), ...(Array.isArray(stored) ? stored : [])]) {
    if (!device?.deviceId) continue;
    const current = byId.get(device.deviceId);
    if (!current || (!current.label?.trim() && device.label?.trim())) byId.set(device.deviceId, device);
  }
  return [...byId.values()];
}

function mapOutputs(devices) {
  return devices
    .filter((device) => device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'communications')
    .map((device) => ({ deviceId: device.deviceId, label: device.label || '' }));
}

function outputScore(devices) {
  return devices.filter((device) => device.deviceId !== 'default' && device.label?.trim()).length;
}

function matchLabel(devices, label) {
  if (!label) return '';
  return devices.find((device) => outputLabel(device) === label)?.deviceId || '';
}

function deviceOption(device) {
  const option = document.createElement('option');
  option.value = device.deviceId;
  option.textContent = outputLabel(device);
  return option;
}

function outputLabel(device) {
  const raw = device.label?.trim() || '';
  if (device.deviceId === 'default') {
    const name = raw.replace(/^(default|predefinito)\s*[-–—]\s*/i, '').trim();
    return name ? `Uscita di sistema (${name})` : 'Uscita di sistema';
  }
  return raw || 'Altoparlante scelto';
}

function render() {
  const scroll = tabList.scrollTop;
  const selectedDevice = deviceSelect.value;
  const visible = state.tabs
    .filter((tab) => state.showAll || tab.audible || state.routes.has(tab.id))
    .sort(compareTabs);

  stopAllButton.hidden = state.routes.size === 0;
  reloadButton.disabled = state.busy;
  stopAllButton.disabled = state.busy;
  deviceSelect.disabled = state.busy;

  if (visible.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = state.showAll
      ? 'Nessuna tab catturabile.'
      : 'Nessuna tab sta riproducendo audio. Avvia YouTube e premi Aggiorna, oppure mostra tutte le tab.';
    tabList.replaceChildren(empty);
    return;
  }

  tabList.replaceChildren(...visible.map((tab) => renderTab(tab, selectedDevice)));
  tabList.scrollTop = scroll;
}

function renderTab(tab, selectedDevice) {
  const routedTo = state.routes.get(tab.id) || '';
  const userMuted = tab.mutedInfo?.muted && tab.mutedInfo.reason === 'user';
  const canForward = !userMuted && (!selectedDevice || routedTo !== selectedDevice);
  const row = document.createElement('li');
  row.className = routedTo ? 'tab routed' : 'tab';
  if (canForward || userMuted) row.classList.add('actionable');
  row.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    if (userMuted) {
      showError('Questa tab è silenziata. Riattiva l\'audio e riprova.');
      return;
    }
    if (canForward) forwardTab(tab);
  });

  const icon = document.createElement('div');
  icon.className = 'icon';
  const letter = document.createElement('span');
  letter.className = 'letter';
  letter.textContent = (tab.title || '?').trim().charAt(0).toUpperCase() || '?';
  icon.append(letter);
  if (typeof tab.favIconUrl === 'string' && /^https?:/i.test(tab.favIconUrl)) {
    const image = document.createElement('img');
    image.alt = '';
    image.referrerPolicy = 'no-referrer';
    image.src = tab.favIconUrl;
    image.addEventListener('error', () => image.remove());
    icon.append(image);
  }

  const body = document.createElement('div');
  body.className = 'tab-body';
  const title = document.createElement('div');
  title.className = 'title';
  title.textContent = tab.title || siteLabel(tab.url) || 'Senza titolo';
  title.title = title.textContent;

  const playing = isPlaying(tab);
  const playback = actionButton(playing ? 'Pausa' : 'Play', 'ghost playback', () => {
    void togglePlayback(tab);
  }, { lock: false });
  playback.disabled = state.toggling === tab.id;
  playback.setAttribute('aria-pressed', playing ? 'true' : 'false');
  playback.title = playing ? 'Metti in pausa questa tab' : 'Riproduci questa tab';

  const titleRow = document.createElement('div');
  titleRow.className = 'title-row';
  titleRow.append(title, playback);

  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = describeTab(tab, routedTo, userMuted);

  const actions = document.createElement('div');
  actions.className = 'actions';

  if (userMuted) {
    actions.append(actionButton('Audio silenziato', 'ghost', () => {
      showError('Questa tab è silenziata. Riattiva l\'audio e riprova.');
    }));
  } else if (!selectedDevice || routedTo !== selectedDevice) {
    const moving = Boolean(routedTo) && Boolean(selectedDevice);
    const label = selectedDevice
      ? `${moving ? 'Sposta' : 'Inoltra'} a ${deviceLabel(selectedDevice)}`
      : 'Scegli l\'uscita e inoltra';
    const button = actionButton(label, 'primary', () => forwardTab(tab));
    button.classList.add('forward');
    actions.append(button);
  }

  if (routedTo) {
    actions.append(actionButton('Ripristina', 'ghost', () => {
      if (state.busy) return;
      void run(() => callBackground({ type: 'stop-route', tabId: tab.id }));
    }));
  }

  body.append(titleRow, meta);
  if (actions.childElementCount) body.append(actions);
  row.append(icon, body);
  return row;
}

function forwardTab(tab) {
  if (state.busy) return;
  const deviceId = deviceSelect.value;
  if (!deviceId) {
    showError('Scegli Echo Studio nel menu Uscita.');
    return;
  }

  if (state.routes.has(tab.id)) {
    void run(() => callBackground({ type: 'move-route', tabId: tab.id, deviceId }));
    return;
  }
  void run(() => callBackground({ type: 'start-route', tabId: tab.id, deviceId }));
}

function actionButton(label, className, onClick, { lock = true } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = lock && state.busy ? 'Attendo…' : label;
  button.disabled = lock && state.busy;
  button.addEventListener('click', onClick);
  return button;
}

function describeTab(tab, routedTo, userMuted) {
  const parts = [];
  const site = siteLabel(tab.url);
  if (site) parts.push(site);
  if (tab.windowId !== state.currentWindowId) parts.push('altra finestra');
  if (userMuted) parts.push('silenziata');
  else if (routedTo) parts.push(`inoltrato · ${deviceLabel(routedTo)}`);
  if (routedTo && state.synced.has(tab.id)) parts.push('video sincronizzato');
  parts.push(isPlaying(tab) ? 'in riproduzione' : 'in pausa');
  return parts.join(' · ');
}

function isPlaying(tab) {
  const override = state.playback.get(tab.id);
  if (override === 'playing') return true;
  if (override === 'paused') return false;
  return Boolean(tab.audible);
}

function reconcilePlayback() {
  for (const tab of state.tabs) {
    const override = state.playback.get(tab.id);
    if (!override) continue;
    if (override === 'playing' && tab.audible) state.playback.delete(tab.id);
    if (override === 'paused' && !tab.audible) state.playback.delete(tab.id);
  }
}

async function togglePlayback(tab) {
  if (state.toggling === tab.id) return;
  state.toggling = tab.id;
  clearError();
  render();
  try {
    const inspected = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: inspectPageMedia
    });
    const frames = inspected
      .map((item) => ({ frameId: item.frameId, ...(item.result || {}) }))
      .filter((item) => item.hasMedia && Number.isInteger(item.frameId));
    if (!frames.length) {
      showError('In questa tab non trovo un video o un audio da controllare.');
      return;
    }

    const playingFrames = frames.filter((item) => item.playing);
    const targets = playingFrames.length
      ? playingFrames
      : [frames.sort((a, b) => b.score - a.score)[0]];
    const acted = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: targets.map((item) => item.frameId) },
      func: setPageMedia,
      args: [playingFrames.length === 0]
    });
    const statuses = acted.map((item) => item.result);
    if (statuses.includes('blocked')) {
      showError('Chrome ha bloccato la riproduzione. Premi play nella tab.');
      return;
    }
    if (!statuses.includes('playing') && !statuses.includes('paused')) {
      showError('In questa tab non trovo un video o un audio da controllare.');
      return;
    }
    state.playback.set(tab.id, playingFrames.length ? 'paused' : 'playing');
  } catch (error) {
    showError(humanize(error.message));
  } finally {
    state.toggling = null;
    render();
  }
}

function inspectPageMedia() {
  const nodes = [...document.querySelectorAll('video, audio')];
  if (!nodes.length) return { hasMedia: false, playing: false, score: 0 };
  const score = nodes.reduce((best, element) => Math.max(best, mediaScore(element)), 0);
  return {
    hasMedia: true,
    playing: nodes.some((element) => !element.paused && !element.ended),
    score
  };

  function mediaScore(element) {
    const area = (element.videoWidth || 0) * (element.videoHeight || 0);
    return area + (element.tagName === 'VIDEO' ? 10 : 0) + (element.currentSrc || element.src ? 5 : 0);
  }
}

async function setPageMedia(shouldPlay) {
  const nodes = [...document.querySelectorAll('video, audio')];
  if (!shouldPlay) {
    let paused = false;
    for (const element of nodes) {
      if (element.paused || element.ended) continue;
      element.pause();
      paused = true;
    }
    return paused ? 'paused' : 'none';
  }

  const target = nodes
    .filter((element) => !element.ended)
    .sort((a, b) => mediaScore(b) - mediaScore(a))[0];
  if (!target) return 'none';
  try {
    await target.play();
    return 'playing';
  } catch {
    return 'blocked';
  }

  function mediaScore(element) {
    const area = (element.videoWidth || 0) * (element.videoHeight || 0);
    return area + (element.tagName === 'VIDEO' ? 10 : 0) + (element.currentSrc || element.src ? 5 : 0);
  }
}

function deviceLabel(deviceId) {
  const option = [...deviceSelect.options].find((item) => item.value === deviceId);
  return option?.textContent || 'dispositivo scelto';
}

function compareTabs(a, b) {
  const score = (tab) => {
    if (state.routes.has(tab.id)) return 0;
    if (tab.audible) return 1;
    return 2;
  };
  const delta = score(a) - score(b);
  if (delta) return delta;
  return (a.title || '').localeCompare(b.title || '', 'it');
}

async function run(task) {
  if (state.busy) return;
  state.busy = true;
  clearError();
  render();
  try {
    await task();
    const listed = await chrome.tabs.query({});
    state.tabs = listed.filter((tab) => capturableUrl(tab.url || ''));
    reconcilePlayback();
  } catch (error) {
    showError(humanize(error.message));
  } finally {
    state.busy = false;
    render();
  }
}

async function callBackground(message) {
  let response;
  try {
    response = await chrome.runtime.sendMessage({ target: 'background', ...message });
  } catch (error) {
    throw new Error(humanize(error.message));
  }
  if (!response?.ok) throw new Error(humanize(response?.error || 'Operazione non riuscita'));
  if (Array.isArray(response.routes)) setRoutes(response.routes);
  return response;
}

function routesArray() {
  return [...state.routes.entries()].map(([tabId, deviceId]) => ({ tabId, deviceId }));
}

function capturableUrl(url) {
  if (url.includes('one-tab-audio')) return false;
  return /^(https?|file):/i.test(url);
}

function siteLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function showError(message) {
  errorBox.hidden = false;
  errorBox.textContent = message;
}

function clearError() {
  errorBox.hidden = true;
  errorBox.textContent = '';
}

function humanize(message) {
  const text = message || 'Qualcosa è andato storto.';
  if (text.includes('Receiving end does not exist')) return 'Il player audio non risponde. Riprova.';
  if (text.includes('not been invoked') || text.includes('activeTab')) {
    return 'Chrome ha bloccato la cattura. Ricarica la tab di YouTube e riprova.';
  }
  if (text.includes('Cannot capture') || text.includes('cannot be captured')) return 'Questa tab non si può catturare.';
  if (text.includes('No tab with id')) return 'Questa tab è stata chiusa.';
  if (text.includes('Invalid sinkId') || text.includes('setSinkId')) {
    return 'Dispositivo non disponibile. Premi «Scegli» e seleziona di nuovo Echo Studio.';
  }
  if (text.includes('Cannot access') || text.includes('cannot be scripted')) {
    return 'Questa pagina non permette di controllare play e pausa.';
  }
  if (text.includes('message port closed')) {
    return 'Sto collegando l\'altoparlante. Riapri l\'estensione tra un attimo.';
  }
  return text;
}
