/* Strategie combinate: promo sui conti deposito, BTP, reinvestimento di interessi e cedole in ETF.
   Simulazione mensile; la parte in ETF è simulata con Monte Carlo (rendimenti lognormali). */
const Strategie = (() => {
  const TAX_DEP = 0.26, BOLLO = 0.002;

  const ETF = {
    azionario: { nome: 'ETF azionario mondo', esempio: 'es. MSCI World / FTSE All-World', mu: 6.0, sigma: 15, tassa: 0.26 },
    bilanciato: { nome: 'ETF bilanciato 60/40', esempio: 'es. 60% azioni mondo, 40% obbligazioni', mu: 4.8, sigma: 9.5, tassa: 0.21 },
    obbligazionario: { nome: 'ETF obbligazionario governativo euro', esempio: 'es. titoli di Stato area euro tutte le scadenze', mu: 3.3, sigma: 5.5, tassa: 0.125 },
    monetario: { nome: 'ETF monetario', esempio: 'es. €STR (XEON, Amundi SMART)', mu: 2.3, sigma: 0.4, tassa: 0.26 }
  };

  function mesiTra(oggi, fine) { return Math.max(0, Math.round((Date.parse(fine) - Date.parse(oggi)) / 2629800000)); }

  // generatore pseudo-casuale riproducibile (stessi risultati a ogni calcolo)
  function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function gauss(r) { let u = 0, v = 0; while (u === 0) u = r(); v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

  /* --- conti: chi è idoneo e che tasso dà mese per mese --- */
  function idoneo(p, f, oggi) {
    if (p.requisito === 'nuovoCliente' && !f.nuovoCliente) return false;
    if (p.requisito === 'nuovaLiquidita' && !f.nuovaLiquidita) return false;
    if (p.scadenzaOfferta && oggi > p.scadenzaOfferta) return false;
    return true;
  }
  function promoMesi(p, oggi) { return p.promoFine ? mesiTra(oggi, p.promoFine) : (p.promoMesi || 0); }
  // tasso lordo annuo che il conto paga al mese m (0 = primo mese) su un saldo dentro il tetto
  function tassoMese(p, m, oggi) { const pm = promoMesi(p, oggi); return pm && m >= pm ? p.tassoDopo : p.tasso; }

  const addM = (oggi, m) => new Date(Date.parse(oggi) + m * 2629800000).toISOString().slice(0, 10);
  // catena di conti: una promo dopo l'altra (ogni banca una volta), poi il miglior conto libero senza promo
  function catenaConti(dati, o) {
    const liberi = dati.prodotti.filter(p => p.tipo === 'libero' && p.cat === 'deposito' && (!p.minimo || o.C >= p.minimo));
    const base = liberi.filter(p => !promoMesi(p, o.oggi) && idoneo(p, o.flags, o.oggi)).sort((a, b) => b.tasso - a.tasso)[0];
    const rBase = base ? base.tasso : 0;
    // ricerca della sequenza migliore (ogni banca una volta, rispettando le scadenze delle offerte)
    const promos = liberi.filter(p => p.tasso > rBase && (promoMesi(p, o.oggi) > 0 || p.promoMesi) && (p.requisito !== 'nuovoCliente' || o.flags.nuovoCliente) && (p.requisito !== 'nuovaLiquidita' || o.flags.nuovaLiquidita));
    let migliore = { v: 0, tappe: [] };
    const cerca = (m, usate, tappe, v) => {
      if (v > migliore.v) migliore = { v, tappe: tappe.slice() };
      if (m >= o.mesi || (!o.multiPromo && tappe.length)) return;
      const data = addM(o.oggi, m);
      for (const p of promos) {
        if (usate.has(p.emittente) || !idoneo(p, o.flags, data)) continue;
        const dur = Math.min(promoMesi(p, data), o.mesi - m);
        if (dur <= 0) continue;
        const cap = Math.min(o.C, p.tetto || Infinity);
        usate.add(p.emittente); tappe.push({ p, da: m, a: m + dur });
        cerca(m + dur, usate, tappe, v + dur * cap * (p.tasso - rBase));
        tappe.pop(); usate.delete(p.emittente);
      }
    };
    cerca(0, new Set(), [], 0);
    const tappe = migliore.tappe;
    return { tappe, base, promo: tappe[0] ? tappe[0].p : null };
  }
  const mesiTxt = n => n === 1 ? '1 mese' : n + ' mesi';

  /* --- simulazione di una strategia ---
     piano = { tipo: 'conti'|'btp'|'etf', reinvesti: null | chiave ETF, ... }  */
  function simula(dati, btpList, BTP, o, piano) {
    const N = o.paths, R = rng(12345), mesi = o.mesi;
    const etf = piano.reinvesti ? Object.assign({}, ETF[piano.reinvesti], o.etfOverride && o.etfOverride[piano.reinvesti] || {}) : null;
    const mu = etf ? Math.log(1 + etf.mu / 100) / 12 - Math.pow(etf.sigma / 100, 2) / 24 : 0, sd = etf ? etf.sigma / 100 / Math.sqrt(12) : 0;
    // flussi deterministici della parte sicura: versamenti nell'ETF mese per mese e valore finale della parte sicura
    const versa = new Array(mesi + 1).fill(0);
    let sicuroFinale = 0, passi = [], avvisi = [], dettaglio = {};

    if (piano.tipo === 'conti') {
      const { tappe, base } = catenaConti(dati, o);
      if (!base && !tappe.length) return null;
      const rBase = base ? base.tasso : 0;
      const tappaDi = m => tappe.find(t => m >= t.da && m < t.a);
      let saldo = o.C, maturato = 0, bollo = 0, primoNetto = null;
      for (let m = 0; m < mesi; m++) {
        const t = tappaDi(m);
        const cap = t ? Math.min(saldo, t.p.tetto || Infinity) : 0;
        const lordo = t ? cap * t.p.tasso / 1200 + (saldo - cap) * rBase / 1200 : saldo * rBase / 1200;
        maturato += lordo * (1 - TAX_DEP);
        bollo += saldo * BOLLO / 12;
        const freq = t ? (t.p.accredito || 3) : (base && base.accredito || 3);
        const fineTappa = t && m + 1 === t.a;
        if ((m + 1) % freq === 0 || fineTappa || m === mesi - 1) {
          if (primoNetto == null && maturato > 0) primoNetto = { v: maturato, f: freq };
          if (etf) versa[m + 1] += maturato; else saldo += maturato;
          maturato = 0;
        }
      }
      sicuroFinale = (etf ? o.C : saldo) - bollo;
      dettaglio.bollo = bollo;
      tappe.forEach((t, i) => {
        passi.push(`${i === 0 ? 'Apri' : `Dopo ${mesiTxt(t.da)} sposti tutto su`} <b>${t.p.nome}</b>: ${fmt(t.p.tasso)}% lordo per ${mesiTxt(t.a - t.da)}${t.p.tetto && o.C > t.p.tetto ? ` sui primi ${eur(t.p.tetto)} (il resto su ${base ? base.nome : 'un altro conto'})` : ''}.`);
        if (t.da > 0) avvisi.push(`${t.p.nome}: l'offerta deve essere ancora attiva tra ${mesiTxt(t.da)}. Oggi non è garantito.`);
        if (t.p.requisito === 'nuovoCliente') avvisi.push(`${t.p.nome}: solo per nuovi clienti.${/accredito/.test(t.p.dettaglio || '') ? ' Richiede anche un accredito mensile (stipendio o bonifico).' : ''}`);
        if (t.p.requisito === 'nuovaLiquidita') avvisi.push(`${t.p.nome}: vale solo sui soldi nuovi portati da un'altra banca.`);
      });
      const fineP = tappe.length ? tappe[tappe.length - 1].a : 0;
      if (base && fineP < mesi) passi.push(tappe.length ? `Finite le promo (dopo ${mesiTxt(fineP)}) sposti tutto su <b>${base.nome}</b> al ${fmt(base.tasso)}%, o su una nuova promo se ne esce una migliore.` : `Metti tutto su <b>${base.nome}</b> al ${fmt(base.tasso)}% lordo.`);
      if (etf) passi.push(`Ogni volta che arrivano gli interessi (${primoNetto ? (primoNetto.f === 1 ? 'ogni mese' : 'ogni ' + primoNetto.f + ' mesi') + ', circa ' + eur(primoNetto.v) + ' netti all\'inizio' : ''}) li investi in un <b>${etf.nome}</b>. Il capitale non lo tocchi.`);
      if (o.C > 100000) avvisi.push('Oltre 100.000 € per banca il fondo di garanzia non copre: dividi su più conti.');
      if (tappe.length > 1) avvisi.push('Cambiare banca a ogni promo richiede di aprire più conti e fare bonifici puntuali; le promo future non sono garantite.');
    }

    if (piano.tipo === 'btp') {
      const t = scegliBtp(btpList, BTP, o);
      if (!t) return null;
      const b = t.b, tAcq = BTP.regolamento(BTP.D(o.oggi));
      const sporco = b.prezzo + BTP.rateo(b, tAcq) * (1 - 0.125);
      const nom = Math.floor(o.C / (sporco / 100) / 1000) * 1000;
      if (nom < 1000) return null;
      const op = BTP.operazione(b, { N: nom, pAcq: b.prezzo, tAcq, comm: o.comm, compensa: false });
      const resto = o.C - op.acq.costoNetto;
      const mesiBtp = Math.round(op.anni * 12);
      const { base } = catenaConti(dati, Object.assign({}, o, { flags: {} }));
      const rBase = base ? base.tasso : 2;
      // parte "capitale": rimborso a 100 al netto di tasse sulla plusvalenza, bollo, rateo e commissione
      const cresci = (v, mm) => v * Math.pow(1 + rBase * (1 - TAX_DEP) / 100, mm / 12);
      const capitale = op.acq.costoNetto + op.netto - op.cedoleNette;
      const mesiDopo = Math.max(0, mesi - mesiBtp);
      let cedoleConto = 0;
      for (const c of op.cedole) {
        const m = Math.min(mesi, Math.max(1, Math.round(BTP.giorni(tAcq, c.t) / 30.4375)));
        if (etf) versa[m] += c.netto; else cedoleConto += cresci(c.netto, mesi - m);
      }
      sicuroFinale = cresci(capitale, mesiDopo) + cresci(resto, mesi) + cedoleConto;
      dettaglio.btp = b; dettaglio.nom = nom;
      passi.push(`Compri <b>${grp(nom)} € nominali</b> di <b>${b.nome}</b> (ISIN ${b.isin}) a ${fmt(b.prezzo)}: ${op.cedole.length} cedole, rimborso a 100 il ${BTP.dataIt(BTP.D(b.scadenza))}.`);
      if (resto > 50) passi.push(`I ${eur(resto)} che avanzano restano su ${base ? base.nome : 'un conto remunerato'}.`);
      passi.push(etf ? `A ogni cedola (circa ${eur(op.cedole.length ? op.cedole[0].netto : 0)} netti) investi l'importo in un <b>${etf.nome}</b>.` : `Le cedole le lasci su ${base ? base.nome : 'un conto remunerato'}.`);
      if (mesiDopo > 0) passi.push(`Il BTP scade ${mesiTxt(mesiDopo)} prima del tuo orizzonte: il rimborso resta sul conto.`);
      if (b.prezzo > 100) avvisi.push('Il BTP è sopra 100: a scadenza hai una minusvalenza, recuperabile solo con plusvalenze da compensare.');
    }

    if (piano.tipo === 'etf') {
      versa[0] = o.C;
      passi.push(`Investi subito tutto in un <b>${etf.nome}</b> (${etf.esempio}) e lo tieni fino alla fine.`);
      avvisi.push('Il capitale non è protetto: nei momenti peggiori un ETF azionario può perdere il 30-50% e restarci per anni.');
    }

    // --- parte ETF: Monte Carlo ---
    const versato = versa.reduce((s, v) => s + v, 0);
    const finali = new Float64Array(N);
    if (etf && versato > 0) {
      for (let k = 0; k < N; k++) {
        let v = 0, bolloE = 0;
        for (let m = 0; m <= mesi; m++) {
          if (m > 0) { v *= Math.exp(mu + sd * gauss(R)); bolloE += v * BOLLO / 12; }
          v += versa[m];
          if (versa[m] > 0 && m < mesi) v -= o.commEtf; // commissione d'acquisto
        }
        const guad = v - versato;
        finali[k] = v - (guad > 0 ? guad * etf.tassa : 0) - bolloE;
      }
    }
    const tot = Array.from(finali, f => f + sicuroFinale).sort((a, b) => a - b);
    const q = p => tot[Math.min(N - 1, Math.max(0, Math.floor(p * N)))];
    const nAcquisti = versa.filter((v, m) => v > 0 && m < mesi).length;
    if (etf && versato > 0) {
      const medioVers = versato / Math.max(1, nAcquisti);
      if (o.commEtf > 0 && o.commEtf / medioVers > 0.01) avvisi.push(`Ogni acquisto di ETF è di circa ${eur(medioVers)}: con ${eur(o.commEtf)} di commissione paghi il ${fmt(o.commEtf / medioVers * 100, 1)}%. Usa un piano di accumulo gratuito o investi gli interessi una volta l'anno.`);
    }
    const anni = mesi / 12;
    const med = q(0.5);
    return {
      piano, passi, avvisi, dettaglio, etf,
      p10: q(0.1), p50: med, p90: q(0.9),
      perdita: tot.filter(v => v < o.C).length / N,
      sicuro: sicuroFinale, versatoEtf: versato, nAcquisti,
      annuo: (Math.pow(med / o.C, 1 / anni) - 1) * 100,
      annuo10: (Math.pow(Math.max(1, q(0.1)) / o.C, 1 / anni) - 1) * 100
    };
  }

  function scegliBtp(btpList, BTP, o) {
    // BTP quotati che scadono entro l'orizzonte (fino a 18 mesi prima): quello con il miglior rendimento netto
    const fine = new Date(Date.parse(o.oggi) + o.mesi * 2629800000).toISOString().slice(0, 10);
    const inizio = new Date(Date.parse(o.oggi) + Math.max(3, o.mesi - 18) * 2629800000).toISOString().slice(0, 10);
    let best = null;
    for (const b of btpList) {
      if (b.prezzo == null || b.unica || b.scadenza > fine || b.scadenza < inizio) continue;
      const s = BTP.sintesi(b, { pAcq: b.prezzo, oggi: o.oggi, N: 10000, comm: o.comm });
      if (s && (!best || s.netto + s.anni * 0.02 > best.s.netto + best.s.anni * 0.02)) best = { b, s };
    }
    return best;
  }

  function fmt(v, d = 2) { return v.toFixed(d).replace('.', ','); }
  function grp(v) { return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function eur(v) { return grp(v) + ' €'; }

  // tutte le strategie per il caso dato
  function proponi(dati, btpList, BTP, o) {
    const etfK = o.etf;
    const piani = [
      { id: 'promo', titolo: 'Caccia alle promo', sub: 'Tutto su conto deposito, interessi che si sommano', tipo: 'conti', reinvesti: null },
      { id: 'promo-etf', titolo: 'Conto promo + interessi in ETF', sub: 'Capitale al sicuro, rischi solo gli interessi', tipo: 'conti', reinvesti: etfK },
      { id: 'btp', titolo: 'BTP fino a scadenza', sub: 'Rendimento bloccato, cedole sul conto', tipo: 'btp', reinvesti: null },
      { id: 'btp-etf', titolo: 'BTP + cedole in ETF', sub: 'Capitale rimborsato a 100, cedole che lavorano', tipo: 'btp', reinvesti: etfK },
      { id: 'etf', titolo: 'Tutto in ETF', sub: 'Per confronto: massimo potenziale, nessuna protezione', tipo: 'etf', reinvesti: etfK }
    ];
    const out = [];
    for (const p of piani) {
      try { const r = simula(dati, btpList, BTP, o, p); if (r) out.push(Object.assign(r, { id: p.id, titolo: p.titolo, sub: p.sub })); } catch (e) { /* strategia non applicabile */ }
    }
    return out;
  }

  return { proponi, ETF, catenaConti, simula };
})();
if (typeof module !== 'undefined') module.exports = Strategie;
