# One Tab Audio

One Tab Audio è un’estensione per Google Chrome che inoltra l’audio delle schede selezionate a un dispositivo di uscita, lasciando le altre sull’uscita di sistema. Per esempio, puoi ascoltare una scheda su un Echo Studio collegato via Bluetooth e continuare a usare gli altoparlanti del computer per le altre.

Il dispositivo deve essere già collegato al computer e riconosciuto come uscita audio. L’estensione non collega direttamente dispositivi Alexa e non usa servizi cloud per trasmettere l’audio.

## Funzionalità

- Elenca le schede che riproducono audio, anche in altre finestre; **Mostra tutte le tab** include anche quelle inattive compatibili.
- Permette di inoltrare più schede, anche verso uscite diverse, e spostare un inoltro su un altro dispositivo.
- Offre i comandi **Play**, **Pausa**, **Ripristina** e **Ripristina tutte**.
- Mantiene l’inoltro quando chiudi il pannello dell’estensione.
- Mostra sull’icona il numero di schede inoltrate.
- Memorizza localmente uscita selezionata, elenco dei dispositivi, volume e silenziamento.

## Requisiti

- Google Chrome **116 o successivo**. Questo minimo è dichiarato nel manifest: da Chrome 116 un identificativo di cattura ottenuto dal service worker può essere consumato dal documento offscreen, ed è disponibile `chrome.runtime.getContexts()`. Vedi la documentazione di [tabCapture](https://developer.chrome.com/docs/extensions/reference/api/tabCapture) e [offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen).
- Un dispositivo audio visibile al sistema operativo: altoparlanti, cuffie, uscita USB o dispositivo Bluetooth.
- Autorizzazione al microfono quando richiesta da Chrome, per rendere disponibili i nomi e le uscite audio. Su macOS potrebbe essere necessaria anche l’autorizzazione di sistema per Chrome.

Il progetto usa HTML, CSS e JavaScript senza dipendenze esterne. Non richiede `npm install`, un server o una compilazione. Node.js serve soltanto per i controlli di sintassi descritti sotto. La compatibilità con altri browser non è verificata.

## Installazione locale

1. Scarica o clona il repository in una cartella locale.
2. Apri `chrome://extensions` in Chrome.
3. Attiva **Modalità sviluppatore**.
4. Premi **Carica estensione non pacchettizzata** e seleziona la cartella che contiene `manifest.json`.
5. Fissa **One Tab Audio** nella barra degli strumenti tramite il menu delle estensioni.

Puoi aprire il pannello con **Ctrl+Shift+Y**; su macOS il manifest propone **Control+Shift+Y**. La scorciatoia può essere modificata in `chrome://extensions/shortcuts`.

Per lavorare su pagine `file://`, abilita anche **Consenti accesso agli URL dei file** nei dettagli dell’estensione.

## Utilizzo

1. Collega il dispositivo audio al computer. Per mantenere separati i suoni delle altre schede, lascia come uscita di sistema gli altoparlanti del computer.
2. Avvia un video o un audio nella scheda da inoltrare e apri l’estensione da quella scheda.
3. Premi **Uscite** per cercare i dispositivi. Si apre una scheda di servizio: consenti l’accesso al microfono se richiesto, poi riapri il pannello.
4. Seleziona il dispositivo nel menu **Uscita**.
5. Premi **Inoltra a …** sulla scheda desiderata. L’estensione porta in primo piano la scheda durante l’avvio; il pannello potrebbe chiudersi.
6. Riapri il pannello per controllare l’inoltro o gestire altre schede. Premi **Aggiorna** se l’elenco non riflette lo stato corrente.

Per cambiare uscita, seleziona un altro dispositivo e premi **Sposta a …** sulla scheda già inoltrata. Il solo cambio del menu non sposta gli inoltri esistenti.

**Ripristina** riporta una scheda all’uscita di sistema; **Ripristina tutte** interrompe tutti gli inoltri. **Play** e **Pausa** controllano gli elementi audio/video rilevati nella pagina; i player personalizzati potrebbero richiedere i comandi del sito.

## Come funziona l’audio

L’estensione prova due modalità, in questo ordine:

| Modalità | Funzionamento | Volume e sincronizzazione |
| --- | --- | --- |
| Uscita diretta (`direct`) | Imposta `HTMLMediaElement.setSinkId()` sugli elementi `<audio>` e `<video>` della pagina principale e segue quelli che iniziano a riprodurre. | Lascia al player e a Chrome la gestione dell’audio/video. Nel pannello compare **video sincronizzato**; usa il volume del player. |
| Cattura (`capture`) | Cattura l’audio della scheda con `chrome.tabCapture` e lo riproduce da `offscreen.html` tramite Web Audio, con un elemento audio come alternativa. | Il cursore **Volume inoltrato** e **Silenzia** agiscono su tutti gli inoltri in questa modalità. La cattura può introdurre ritardo rispetto al video. |

Il volume della cattura va da **0% a 150%**; oltre il 100% il segnale viene amplificato e può distorcere. Questi controlli non regolano le schede in modalità diretta. I tasti volume del computer agiscono sull’uscita gestita dal sistema operativo.

In modalità diretta l’uscita viene individuata nella pagina tramite il nome del dispositivo, perché gli identificativi possono differire tra origini. Chrome può chiedere il permesso del microfono anche sul sito. Se il percorso diretto non è disponibile, l’estensione tenta la cattura.

## Permessi e dati

| Permesso nel manifest | Utilizzo |
| --- | --- |
| `tabCapture` | Ottiene il flusso audio della scheda per la modalità cattura. |
| `tabs` | Legge titolo, URL e stato delle schede e gestisce attivazione e silenziamento. |
| `activeTab` | Consente l’accesso temporaneo alla scheda dalla quale invochi l’estensione, necessario per avviare la cattura. |
| `offscreen` | Crea il documento nascosto che gestisce dispositivi e riproduzione audio. |
| `storage` | Salva preferenze locali e stato della sessione. |
| `scripting` | Esegue nelle pagine i comandi per uscita diretta, play e pausa. |
| Host `<all_urls>` | Permette di eseguire questi comandi sulle pagine delle schede elencate, incluse quelle diverse dalla scheda attiva. |

La richiesta al microfono apre brevemente un flusso e ne arresta le tracce appena ottenuto il permesso. Il codice non registra il microfono e non salva l’audio delle schede: il flusso catturato viene riprodotto localmente. Non sono presenti backend o telemetria; il pannello può caricare le favicon delle schede dai rispettivi URL.

Le preferenze sono in `chrome.storage.local` e `localStorage`; gli inoltri diretti e le schede silenziate dall’estensione sono tracciati in `chrome.storage.session`. Non è previsto il ripristino automatico degli inoltri dopo il riavvio completo del browser.

## Struttura del progetto

```text
.
├── manifest.json       # Manifest V3, permessi, versione e scorciatoia
├── background.js       # Service worker: inoltri, cattura, stato e badge
├── popup.html          # Pannello dell’estensione
├── popup.css           # Stili del pannello
├── popup.js            # Dispositivi, elenco schede e comandi utente
├── offscreen.html      # Documento nascosto per la riproduzione
├── offscreen.js        # Flussi catturati, uscita audio e guadagno
├── mic.html            # Pagina per autorizzazione e ricerca delle uscite
├── mic.js              # Rilevamento e salvataggio dei dispositivi
└── icons/              # Icone PNG da 16, 32, 48 e 128 pixel
```

## Sviluppo e verifica

Dopo una modifica, apri `chrome://extensions` e premi **Ricarica** sulla scheda dell’estensione. Ricarica anche le pagine coinvolte per eliminare eventuali inoltri diretti rimasti nella pagina, poi avvia nuovamente gli inoltri.

Per verificare la sintassi JavaScript, dalla cartella del progetto:

```sh
node --check background.js
node --check offscreen.js
node --check popup.js
node --check mic.js
```

Per vedere gli errori del service worker, usa il collegamento **Service worker** nei dettagli dell’estensione. Per il pannello, apri il popup e usa **Ispeziona** dal menu contestuale.

La verifica statica della configurazione comprende manifest JSON, presenza delle risorse, dimensioni delle icone e corrispondenza fra riferimenti HTML e selettori JavaScript. Non è presente una suite di test automatizzata. Per verificare il comportamento reale in Chrome:

1. Inoltra una scheda con un player HTML a un dispositivo e verifica che un’altra scheda resti sull’uscita di sistema.
2. Verifica play/pausa, cambio uscita e ripristino della singola scheda.
3. Su una scheda che usa la cattura, verifica volume e silenziamento, anche dopo aver chiuso il popup.
4. Inoltra più schede e verifica **Ripristina tutte** e la chiusura di una scheda inoltrata.
5. Prova il ricaricamento di una pagina e la disconnessione/riconnessione del dispositivo.

La resa audio e la sincronizzazione richiedono una prova con il dispositivo reale: i controlli statici non le verificano.

## Limiti e risoluzione dei problemi

- **Il dispositivo non compare:** verifica il collegamento nel sistema operativo, premi **Uscite** e concedi il permesso al microfono. Se necessario, riavvia Chrome con il dispositivo già connesso. L’elenco include anche nomi memorizzati: una voce presente non garantisce che il dispositivo sia ancora collegato.
- **Chrome blocca la cattura:** porta in primo piano la scheda interessata, apri da lì l’estensione e riprova. Attivare una scheda dal pannello non equivale a invocare l’estensione su quella scheda; `tabCapture` richiede il relativo accesso `activeTab`. Vedi [le condizioni di cattura](https://developer.chrome.com/docs/extensions/reference/api/tabCapture).
- **La scheda è silenziata manualmente:** riattiva l’audio nel browser prima di inoltrarla. L’estensione preserva il silenziamento imposto dall’utente durante il ripristino.
- **Il cursore non modifica il volume:** se compare **video sincronizzato**, usa il volume del player nella pagina; anche **Silenzia** vale solo per la cattura.
- **Audio e video sono fuori sincrono:** il percorso di cattura e i dispositivi Bluetooth possono introdurre latenza. La modalità diretta evita il passaggio attraverso il player offscreen, ma non garantisce la sincronizzazione su ogni sito o dispositivo.
- **Il player non viene controllato:** play/pausa cerca elementi HTML audio/video, anche nei frame accessibili. Il percorso diretto opera solo sul frame principale; player in iframe, shadow DOM o basati esclusivamente su Web Audio possono richiedere la cattura o i comandi del sito.
- **La pagina non è compatibile:** le pagine interne di Chrome e le pagine protette dalle restrizioni del browser non sono controllabili. I contenuti protetti possono avere ulteriori limitazioni.
- **L’inoltro sparisce dopo una navigazione:** il service worker prova a riapplicare le uscite dirette al completamento del caricamento. Se la nuova pagina non permette l’operazione, l’inoltro viene rimosso e va avviato nuovamente.