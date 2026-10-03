const button = document.querySelector('#allow');
const status = document.querySelector('#status');

button.addEventListener('click', () => {
  void allow();
});

void allow();

async function allow() {
  button.disabled = true;
  setStatus('Cerco le uscite…');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((track) => track.stop());
    const listed = await navigator.mediaDevices.enumerateDevices();
    const devices = listed
      .filter((device) => device.kind === 'audiooutput' && device.deviceId && device.deviceId !== 'communications')
      .map((device) => ({ deviceId: device.deviceId, label: device.label || '' }));
    await chrome.storage.local.set({ outputDevices: devices });
    const names = devices
      .filter((device) => device.deviceId !== 'default' && device.label?.trim())
      .map((device) => device.label.trim());
    if (!names.length) {
      setStatus('Permesso concesso, ma i nomi non ci sono ancora. Chiudi Chrome con Cmd+Q e riaprilo con l\'altoparlante connesso.');
      button.disabled = false;
      return;
    }
    setStatus(`Trovati: ${names.join(', ')}. Puoi chiudere questa scheda.`, true);
    setTimeout(() => window.close(), 1600);
  } catch (error) {
    button.disabled = false;
    if (error?.name === 'NotAllowedError') {
      setStatus('Premi Cerca di nuovo, poi Consenti nel riquadro di Chrome.');
      return;
    }
    setStatus(error?.message || 'Richiesta non riuscita.');
  }
}

function setStatus(message, ready = false) {
  status.textContent = message;
  status.classList.toggle('ready', ready);
}
