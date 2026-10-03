const routes = new Map();
let outputVolume = 1;
let outputMuted = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen') return;

  onMessage(message)
    .then(sendResponse)
    .catch((error) => {
      console.error(error);
      sendResponse({
        ok: false,
        error: error?.message || 'Riproduzione non riuscita',
        routes: currentRoutes()
      });
    });
  return true;
});

async function onMessage(message) {
  switch (message.type) {
    case 'ping':
    case 'status':
      return payload();
    case 'devices':
      return { ok: true, devices: await outputDevices(), routes: currentRoutes() };
    case 'start':
      await startRoute(message);
      return payload();
    case 'move':
      await moveRoute(message);
      return payload();
    case 'stop':
      await stopRoute(message.tabId);
      return payload();
    case 'stop-all':
      await stopAll();
      return payload();
    case 'volume':
      await applyLevels(message.volume, message.muted);
      return payload();
    default:
      throw new Error('Comando sconosciuto');
  }
}

async function startRoute({ tabId, streamId, deviceId, volume, muted }) {
  if (!Number.isInteger(tabId)) throw new Error('Tab non valida.');
  if (typeof streamId !== 'string' || streamId.length === 0) {
    throw new Error('Cattura non avviata. Riprova.');
  }
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new Error('Scegli un dispositivo di uscita.');
  }

  await stopRoute(tabId);

  let stream;
  let playback;
  try {
    stream = await captureStream(streamId);
    rememberLevels(volume, muted);
    playback = await openPlayback(stream, deviceId);
    const track = stream.getAudioTracks()[0];
    if (!track) throw new Error('Questa tab non ha una traccia audio.');
    track.addEventListener('ended', () => {
      const current = routes.get(tabId);
      if (current?.stream === stream) void stopRoute(tabId, { notify: true });
    });
    playback.stream = stream;
    routes.set(tabId, playback);
    chrome.runtime.sendMessage({ target: 'background', type: 'mute-tab', tabId }).catch(() => {});
  } catch (error) {
    releasePlayback(playback, stream);
    throw sinkError(error);
  }
}

async function openPlayback(stream, deviceId) {
  try {
    return await openDirectPlayback(stream, deviceId);
  } catch (error) {
    console.warn('Uscita diretta non disponibile, uso il percorso compatibile.', error);
    return openElementPlayback(stream, deviceId);
  }
}

async function openDirectPlayback(stream, deviceId) {
  if (typeof AudioContext.prototype.setSinkId !== 'function') {
    throw new Error('setSinkId non supportato');
  }

  try {
    return await startDirect(stream, deviceId, true);
  } catch (error) {
    if (error?.name === 'NotFoundError') throw error;
    return startDirect(stream, deviceId, false);
  }
}

async function startDirect(stream, deviceId, bindSink) {
  const context = bindSink
    ? new AudioContext({ latencyHint: 0, sinkId: deviceId })
    : new AudioContext({ latencyHint: 0 });
  let source;
  let gain;
  const resume = () => {
    if (context.state === 'suspended') void context.resume().catch(() => {});
  };
  try {
    if (context.sinkId !== deviceId) await context.setSinkId(deviceId);
    source = context.createMediaStreamSource(stream);
    gain = context.createGain();
    gain.gain.value = heardGain();
    source.connect(gain);
    gain.connect(context.destination);
    context.addEventListener('statechange', resume);
    resume();
    return { deviceId, context, source, gain, resume };
  } catch (error) {
    context.removeEventListener('statechange', resume);
    disconnectNodes(source, gain);
    await context.close().catch(() => {});
    throw error;
  }
}

async function openElementPlayback(stream, deviceId) {
  const context = new AudioContext({ latencyHint: 'interactive' });
  const source = context.createMediaStreamSource(stream);
  const gain = context.createGain();
  const destination = context.createMediaStreamDestination();
  gain.gain.value = heardGain();
  source.connect(gain);
  gain.connect(destination);

  const audio = new Audio();
  audio.srcObject = destination.stream;
  audio.hidden = true;
  document.body.append(audio);
  try {
    await audio.setSinkId(deviceId);
    await audio.play();
    if (context.state === 'suspended') await context.resume();
    return { deviceId, audio, context, source, gain };
  } catch (error) {
    audio.pause();
    audio.srcObject = null;
    audio.remove();
    disconnectNodes(source, gain);
    await context.close().catch(() => {});
    throw error;
  }
}

async function applyLevels(volume, muted) {
  rememberLevels(volume, muted);
  const level = heardGain();
  for (const route of routes.values()) {
    if (route.gain) route.gain.gain.value = level;
  }
}

function rememberLevels(volume, muted) {
  if (typeof volume === 'number') outputVolume = clampVolume(volume);
  if (typeof muted === 'boolean') outputMuted = muted;
}

function heardGain() {
  return outputMuted ? 0 : outputVolume;
}

function clampVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return outputVolume;
  return Math.min(1.5, Math.max(0, number));
}

async function outputDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const listed = await navigator.mediaDevices.enumerateDevices();
  return listed
    .filter((device) => device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'communications')
    .map((device) => ({ deviceId: device.deviceId, label: device.label || '' }));
}

async function moveRoute({ tabId, deviceId }) {
  const route = routes.get(tabId);
  if (!route) throw new Error('Questa tab non è inoltrata.');
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new Error('Scegli un dispositivo di uscita.');
  }
  if (route.audio) await route.audio.setSinkId(deviceId);
  else await route.context.setSinkId(deviceId);
  route.deviceId = deviceId;
}

async function stopRoute(tabId, { notify = false } = {}) {
  const route = routes.get(tabId);
  if (!route) return;
  routes.delete(tabId);
  releasePlayback(route, route.stream);
  chrome.runtime.sendMessage({ target: 'background', type: 'unmute-tab', tabId }).catch(() => {});

  if (notify) {
    chrome.runtime.sendMessage({
      target: 'background',
      type: 'routes-changed',
      routes: currentRoutes()
    }).catch(() => {});
  }
}

function releasePlayback(playback, stream) {
  if (playback?.resume) playback.context?.removeEventListener('statechange', playback.resume);
  disconnectNodes(playback?.source, playback?.gain);
  if (playback?.audio) {
    playback.audio.pause();
    playback.audio.srcObject = null;
    playback.audio.remove();
  }
  void playback?.context?.close().catch(() => {});
  stream?.getTracks().forEach((track) => track.stop());
}

function disconnectNodes(source, gain) {
  try {
    source?.disconnect();
  } catch {
    // The node may already be disconnected.
  }
  try {
    gain?.disconnect();
  } catch {
    // The node may already be disconnected.
  }
}

async function stopAll() {
  await Promise.all([...routes.keys()].map((tabId) => stopRoute(tabId)));
}

async function captureStream(streamId) {
  const source = {
    chromeMediaSource: 'tab',
    chromeMediaSourceId: streamId
  };

  try {
    return await navigator.mediaDevices.getUserMedia({ audio: { mandatory: source }, video: false });
  } catch (error) {
    const text = `${error?.name || ''} ${error?.message || ''}`;
    if (!/constraint|mandatory|syntax/i.test(text)) throw error;
    return navigator.mediaDevices.getUserMedia({ audio: source, video: false });
  }
}

function sinkError(error) {
  if (error?.name === 'NotAllowedError') {
    return new Error('Chrome non accetta questa uscita. Premi «Uscite» e selezionala di nuovo.');
  }
  if (error?.name === 'NotFoundError') {
    return new Error('Dispositivo scollegato. Aggiorna l\'elenco.');
  }
  return error;
}

function currentRoutes() {
  return [...routes.entries()].map(([tabId, route]) => ({
    tabId,
    deviceId: route.deviceId
  }));
}

function payload() {
  return { ok: true, routes: currentRoutes() };
}
