# Parcheggio Liquidità

Web app installabile (PWA) per decidere dove parcheggiare la liquidità: BOT/BTP e titoli di Stato in euro (Germania, Francia, Spagna, Portogallo, Grecia, Polonia, Romania), buoni fruttiferi postali, depositi Supersmart, conti deposito, ETF monetari e governativi.

Per ogni opzione calcola rendimento netto dopo tasse (12,5% / 26%), bollo e costi, rendimento reale rispetto all'inflazione, rischio (1-5) e possibilità di uscita anticipata, in base a importo, orizzonte, bisogno di liquidità e profilo di rischio.

## File

| File | Cosa contiene |
|---|---|
| `index.html` | Interfaccia |
| `motore.js` | Motore di calcolo (tasse, bollo, rischio, classifica) |
| `btp.html`, `btp-motore.js` | Analisi di un singolo BTP: rateo, cedole, tasse, guadagno a scadenza, vendita anticipata, prezzo di pareggio e scenari di prezzo |
| `btp.json` | Elenco BTP a tasso fisso con cedola, scadenza e ultimo prezzo (Borsa Italiana MOT). Aggiornato ogni settimana |
| `mercato.json` | Dati di mercato: curve dei rendimenti, tassi di buoni e conti deposito, macro. Aggiornato ogni settimana |
| `sw.js` | Service worker: funziona offline, scarica sempre i dati nuovi quando c'è rete |
| `manifest.webmanifest`, `icons/` | Installazione sulla home |

## Installare sul telefono

- **Android (Chrome):** apri il sito → menu ⋮ → *Installa app* (o *Aggiungi a schermata Home*).
- **iPhone (Safari):** apri il sito → Condividi → *Aggiungi alla schermata Home*.

## Aggiornare i dati

Basta modificare `mercato.json` mantenendo la stessa struttura. Quando cambi `index.html`, `motore.js` o `sw.js`, incrementa `VERSIONE` in `sw.js` così l'app installata propone l'aggiornamento.

Strumento informativo, non consulenza finanziaria.
