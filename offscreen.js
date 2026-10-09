const routes = new Map();
const START_TIMEOUT_MS = 12000;
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

  stopRoute(tabId);

  // Own the capture before awaiting the device: Stop must also reach unfinished starts.
  const route = { deviceId, state: 'starting', controller: new AbortController() };
  routes.set(tabId, route);
  const timer = setTimeout(() => route.controller.abort(
    new Error('L’uscita audio non risponde. Inoltro interrotto: riprova.')
  ), START_TIMEOUT_MS);
  notifyRoutes();
  // Apply the start snapshot before any wait; later volume messages take precedence.
  rememberLevels(volume, muted);
  try {
    route.stream = await waitFor(captureStream(streamId), route, (stream) => {
      stream.getTracks().forEach((track) => track.stop());
    });
    const track = route.stream.getAudioTracks()[0];
    if (!track || track.readyState === 'ended') throw new Error('Questa tab non ha una traccia audio.');
    track.addEventListener('ended', () => {
      if (routes.get(tabId) === route) void stopRoute(tabId, { notify: true });
    });
    Object.assign(route, await openPlayback(route.stream, deviceId, route));
    route.controller.signal.throwIfAborted();
    route.gain.gain.value = heardGain();
    route.state = 'active';
    // tabCapture already suppresses the original audio; an extra tabs.update(muted)
    // can race with Stop and leave the page permanently silent.
    notifyRoutes();
  } catch (error) {
    if (routes.get(tabId) === route) routes.delete(tabId);
    route.controller.abort(error);
    releasePlayback(route, route.stream);
    notifyRoutes();
    throw sinkError(error);
  } finally {
    clearTimeout(timer);
  }
}

// Media APIs cannot always be cancelled. Release a stream arriving after Stop/timeout.
function waitFor(promise, route, releaseLate) {
  const signal = route.controller.signal;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then((value) => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) releaseLate?.(value);
      else resolve(value);
    }, (error) => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
  });
}

async function openPlayback(stream, deviceId, route) {
  try {
    return await openDirectPlayback(stream, deviceId, route);
  } catch (error) {
    route.controller.signal.throwIfAborted();
    console.warn('Uscita diretta non disponibile, uso il percorso compatibile.', error);
    return openElementPlayback(stream, deviceId, route);
  }
}

async function openDirectPlayback(stream, deviceId, route) {
  if (typeof AudioContext.prototype.setSinkId !== 'function') {
    throw new Error('setSinkId non supportato');
  }

  try {
    return await startDirect(stream, deviceId, true, route);
  } catch (error) {
    route.controller.signal.throwIfAborted();
    if (error?.name === 'NotFoundError') throw error;
    return startDirect(stream, deviceId, false, route);
  }
}

async function startDirect(stream, deviceId, bindSink, route) {
  const context = bindSink
    ? new AudioContext({ latencyHint: 0, sinkId: deviceId })
    : new AudioContext({ latencyHint: 0 });
  let source;
  let gain;
  const resume = () => {
    if (context.state === 'suspended') void context.resume().catch(() => {});
  };
  try {
    if (context.sinkId !== deviceId) await waitFor(context.setSinkId(deviceId), route);
    source = context.createMediaStreamSource(stream);
    gain = context.createGain();
    gain.gain.value = heardGain();
    source.connect(gain);
    gain.connect(context.destination);
    context.addEventListener('statechange', resume);
    if (context.state !== 'running') await waitFor(context.resume(), route);
    if (context.state !== 'running') throw new Error('Il player audio non si è avviato. Riprova.');
    return { deviceId, context, source, gain, resume };
  } catch (error) {
    context.removeEventListener('statechange', resume);
    disconnectNodes(source, gain);
    void context.close().catch(() => {});
    throw error;
  }
}

async function openElementPlayback(stream, deviceId, route) {
  const context = new AudioContext({ latencyHint: 'interactive' });
  let source, gain, destination, audio;
  try {
    source = context.createMediaStreamSource(stream);
    gain = context.createGain();
    destination = context.createMediaStreamDestination();
    gain.gain.value = heardGain();
    source.connect(gain);
    gain.connect(destination);
    audio = new Audio();
    audio.srcObject = destination.stream;
    audio.hidden = true;
    document.body.append(audio);
    await waitFor(audio.setSinkId(deviceId), route);
    await waitFor(audio.play(), route);
    if (context.state !== 'running') await waitFor(context.resume(), route);
    if (context.state !== 'running') throw new Error('Il player audio non si è avviato. Riprova.');
    return { deviceId, audio, context, source, gain, destination };
  } catch (error) {
    releasePlayback({ audio, context, source, gain, destination });
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
  if (route.state === 'starting') throw new Error('Inoltro in avvio. Premi Ripristina per annullarlo.');
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
  route.controller.abort(new Error('Inoltro annullato.'));
  releasePlayback(route, route.stream);
  chrome.runtime.sendMessage({ target: 'background', type: 'unmute-tab', tabId }).catch(() => {});

  if (notify) notifyRoutes();
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
  playback?.destination?.stream.getTracks().forEach((track) => track.stop());
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
    deviceId: route.deviceId,
    state: route.state
  }));
}

function payload() {
  return { ok: true, routes: currentRoutes() };
}

function notifyRoutes() {
  chrome.runtime.sendMessage({
    target: 'background', type: 'routes-changed', routes: currentRoutes()
  }).catch(() => {});
}
