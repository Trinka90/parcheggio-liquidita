/* Motore di calcolo: rendimenti netti, tasse, bollo, costi, rischio, liquidità */
const Motore = (() => {
  const LAMBDA = [0.9, 0.5, 0.12]; // prudente, equilibrato, dinamico
  const USCITA = {
    libera: 'Prelevabile quando vuoi',
    mercato: 'Vendibile ogni giorno in Borsa, a prezzo di mercato',
    svincolabile: 'Svincolabile prima, perdendo interessi',
    perdiInteressi: 'Rimborsabile prima, ma perdi gli interessi',
    bloccato: 'Bloccato fino a scadenza'
  };

  function periodo(m) {
    if (m < 12) return m === 1 ? '1 mese' : m + ' mesi';
    if (m % 12 === 0) return m === 12 ? '1 anno' : (m / 12) + ' anni';
    return m + ' mesi';
  }
  function anniTxt(a) { return a === 1 ? '1 anno' : a + ' anni'; }

  function interp(p, t) {
    if (t <= p[0][0]) return p[0][1];
    for (let i = 1; i < p.length; i++) {
      if (t <= p[i][0]) {
        const [a, ya] = p[i - 1], [b, yb] = p[i];
        return ya + (yb - ya) * (t - a) / (b - a);
      }
    }
    return p[p.length - 1][1];
  }

  // interessi tassati ogni anno e reinvestiti al netto: restituisce l'interesse lordo equivalente
  function lordoAnnuo(C, y, H, a) {
    const k = 1 - a / 100;
    return C * (Math.pow(1 + y * k / 100, H) - 1) / k;
  }
  // credito: pesa meno sulle scadenze brevi
  function credTempo(rn, H) { return 1 + (rn - 1) * Math.min(1, 0.4 + 0.12 * H); }

  function nuovo(p, extra) {
    return Object.assign({
      id: p.id, nome: p.nome, cat: p.cat, emittente: p.emittente || '', rating: p.rating || '',
      garanzia: p.garanzia || '', dettaglio: p.dettaglio || '', fonte: p.fonte || '',
      stima: p.stima || '', note: [], escluso: null, tua: !!p.tua
    }, extra || {});
  }

  function chiudi(r, ctx, lordo, aliquota, bolloTipo, costi) {
    const { C, H } = ctx;
    const tasse = Math.max(0, lordo) * aliquota / 100;
    let bollo = 0;
    if (bolloTipo === 'titoli') bollo = 0.002 * C * H;
    else if (bolloTipo === 'fisso') bollo = C > 5000 ? 34.2 * H : 0;
    else if (bolloTipo === 'bfp') bollo = C > 5000 ? 0.002 * C * H : 0;
    const netto = lordo - tasse - bollo - costi;
    Object.assign(r, { lordo, tasse, bollo, costi, netto, finale: C + netto, aliquota, bolloTipo });
    r.nettoAnnuo = (Math.pow(Math.max(r.finale, 0.01) / C, 1 / H) - 1) * 100;
    r.lordoAnnuo = (Math.pow((C + lordo) / C, 1 / H) - 1) * 100;
    r.realeAnnuo = ((1 + r.nettoAnnuo / 100) / (1 + ctx.infl / 100) - 1) * 100;
  }

  function rischio(r, ctx, credito, duration, uscita, scadenzaFissa) {
    const nf = [0.25, 0.6, 1][ctx.need];
    const f = scadenzaFissa ? nf : Math.max(nf, 0.6);
    const prezzo = uscita === 'mercato' ? Math.min(3, duration * 0.35) * f : 0;
    let cred = credito;
    if ((r.cat === 'deposito' || r.cat === 'conto') && ctx.C > 100000) {
      cred += 1.5;
      r.note.push('Oltre 100.000 € per banca il fondo di garanzia non ti copre: dividi la somma su più banche.');
    }
    r.rischioPunti = cred + prezzo;
    const x = r.rischioPunti;
    r.rischio = x <= 1.25 ? 1 : x <= 1.9 ? 2 : x <= 2.6 ? 3 : x <= 3.5 ? 4 : 5;
    r.uscita = uscita;
    r.uscitaTxt = USCITA[uscita];
    r.duration = duration;
    r.prezzoRischio = prezzo;
  }

  function liqPen(uscita, need, dur) {
    if (need === 0) return 0;
    const t = {
      libera: [0, 0], mercato: [0.1 + 0.08 * dur, 0.2 + 0.2 * dur],
      svincolabile: [0.3, 0.7], perdiInteressi: [0.5, 1.2], bloccato: [0.9, 2.5]
    };
    return t[uscita][need - 1];
  }

  function requisiti(p, r, ctx) {
    if (p.requisito === 'nuovaLiquidita' && !ctx.flags.nuovaLiquidita)
      r.escluso = 'Serve nuova liquidità portata in Poste (attiva l\'opzione se ce l\'hai).';
    if (p.scadenzaOfferta && ctx.oggi > p.scadenzaOfferta)
      r.escluso = 'Offerta scaduta il ' + p.scadenzaOfferta.split('-').reverse().join('/') + '.';
    if (p.minimo && ctx.C < p.minimo)
      r.escluso = 'Importo minimo ' + String(p.minimo).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' €.';
  }

  /* --- tipi di strumento --- */

  function fonteOk(p, t) {
    for (let i = 0; i < p.length; i++) {
      if (Math.abs(p[i][0] - t) < 1e-6) return !!p[i][2];
      if (t < p[i][0]) return i > 0 && !!p[i - 1][2] && !!p[i][2];
    }
    return !!p[p.length - 1][2];
  }

  function curva(c, ctx) {
    const { C, H, Hm } = ctx;
    const maxT = c.punti[c.punti.length - 1][0];
    let nome;
    if (c.id === 'it') nome = Hm <= 12 ? 'BOT ' + periodo(Hm) : 'BTP con scadenza tra ~' + periodo(Hm);
    else nome = c.nome + ' (' + c.paese.replace(' (in euro)', '') + ') scadenza ~' + periodo(Math.max(Hm, Math.round(c.minAnni * 12)));
    const r = nuovo({ id: 'curva-' + c.id, nome, cat: 'stato', emittente: c.paese, rating: c.rating,
      garanzia: 'Stato emittente (' + c.paese.replace(' (in euro)', '') + ')', dettaglio: c.note, fonte: 'Curva dei rendimenti', stima: c.stima });
    r.paese = c.id;
    if (H < c.minAnni - 1e-9) {
      r.escluso = c.paese + ': nessun titolo in euro così breve facilmente acquistabile.';
      return r;
    }
    if (C < c.lotto) r.escluso = 'Taglio minimo ' + c.lotto + ' €.';
    const t = Math.min(H, maxT);
    const y = interp(c.punti, t);
    const lordo = lordoAnnuo(C, y, H, 12.5);
    r.daStima = !fonteOk(c.punti, t);
    const costi = ctx.comm + C * c.spreadDenaroLettera / 200;
    chiudi(r, ctx, lordo, 12.5, 'titoli', costi);
    r.tassoLordo = y;
    rischio(r, ctx, credTempo(c.ratingNum, H), t * 0.92, 'mercato', true);
    r.note.push('Rendimento bloccato solo se lo tieni fino a scadenza: se vendi prima il prezzo può essere più alto o più basso.');
    if (H > maxT) r.note.push('Scadenza più lunga considerata: ' + anniTxt(maxT) + ', poi rinnovo allo stesso tasso.');
    if (c.outlook === 'negativo') r.note.push('Outlook del rating negativo: rischio di declassamento.');
    return r;
  }

  function fisso(p, ctx) {
    const { C, H } = ctx;
    const r = nuovo(p);
    requisiti(p, r, ctx);
    const T = p.durataMesi / 12;
    if (H < T - 1e-9) {
      r.escluso = 'Dura ' + periodo(p.durataMesi) + ': con il tuo orizzonte dovresti venderlo prima a prezzo di mercato.';
      return r;
    }
    const lordo = lordoAnnuo(C, p.tasso, H, p.aliquota);
    const costi = (p.commissione != null ? p.commissione : ctx.comm) + C * (p.spreadDenaroLettera || 0) / 200;
    chiudi(r, ctx, lordo, p.aliquota, p.bollo, costi);
    r.tassoLordo = p.tasso;
    rischio(r, ctx, credTempo(p.ratingNum, H), p.duration || T * 0.9, p.uscita, true);
    if (H > T + 1e-9) r.note.push('Dopo ' + periodo(p.durataMesi) + ' ipotizzo un rinnovo allo stesso tasso.');
    return r;
  }

  function bfp(p, ctx) {
    const { C, H } = ctx;
    const r = nuovo(p);
    requisiti(p, r, ctx);
    const T = p.durataMesi / 12, sc = p.scaglioni;
    const maturato = y => { let s = null; for (const x of sc) if (x[0] <= y + 1e-9) s = x; return s; };
    let lordo;
    if (H <= T + 1e-9) {
      const s = maturato(H);
      if (!s) {
        lordo = 0;
        r.note.push('Prima di ' + anniTxt(sc[0][0]) + ' non maturano interessi: riavresti solo il capitale.');
      } else {
        lordo = C * (Math.pow(1 + s[1] / 100, s[0]) - 1);
        if (s[0] < H - 0.01) r.note.push('Interessi a scaglioni: quelli maturati si fermano a ' + anniTxt(s[0]) + ' fino al prossimo scaglione.');
      }
    } else {
      const last = sc[sc.length - 1];
      const k = Math.floor(H / T + 1e-9);
      let v = C * Math.pow(1 + last[1] / 100, T * k);
      const s2 = maturato(H - k * T);
      if (s2) v *= Math.pow(1 + s2[1] / 100, s2[0]);
      lordo = v - C;
      r.note.push('Dopo la scadenza ipotizzo di rinnovare allo stesso tasso.');
    }
    chiudi(r, ctx, lordo, p.aliquota, p.bollo, 0);
    r.tassoLordo = sc[sc.length - 1][1];
    rischio(r, ctx, credTempo(p.ratingNum, H), 0, p.uscita, true);
    if (C <= 5000) r.note.push('Fino a 5.000 € complessivi in buoni non paghi il bollo.');
    return r;
  }

  function bfpInfl(p, ctx) {
    const { C, H, Hm } = ctx;
    const r = nuovo(p);
    requisiti(p, r, ctx);
    let lordo = 0;
    if (Hm < (p.minMesiInteressi || 0)) {
      r.note.push('Prima di ' + p.minMesiInteressi + ' mesi non maturano interessi.');
    } else {
      const yrs = Math.floor(H + 1e-9);
      const f = p.fissi[Math.min(yrs, p.fissi.length) - 1] || 0;
      lordo = C * (Math.pow((1 + ctx.infl / 100) * (1 + f / 100), yrs) - 1);
      if (yrs < H - 0.01) r.note.push('Interessi calcolati sugli anni interi maturati (' + anniTxt(yrs) + ').');
      if (H > 10) r.note.push('Oltre 10 anni ipotizzo un rinnovo alle stesse condizioni.');
    }
    chiudi(r, ctx, lordo, p.aliquota, p.bollo, 0);
    r.tassoLordo = ctx.infl + p.fissi[p.fissi.length - 1];
    r.note.push('Calcolato con inflazione ipotizzata al ' + ctx.infl.toLocaleString('it-IT') + '% annuo: cambia l\'ipotesi per vedere altri scenari.');
    rischio(r, ctx, credTempo(p.ratingNum, H), 0, p.uscita, true);
    return r;
  }

  function vincolato(p, ctx) {
    const { C, H, Hm } = ctx;
    const r = nuovo(p);
    requisiti(p, r, ctx);
    const T = p.durataMesi;
    let lordo;
    if (Hm < T) {
      if (p.uscita === 'svincolabile') {
        lordo = C * (p.tassoSvincolo || 0) / 100 * H;
        r.note.push('Il vincolo è di ' + periodo(T) + ': uscendo prima ipotizzo che perdi gli interessi.');
      } else {
        r.escluso = 'Vincolo di ' + periodo(T) + ', più lungo del tuo orizzonte.';
        return r;
      }
    } else {
      const n = Math.floor(Hm / T);
      const fermo = Hm - n * T;
      const k = 1 - p.aliquota / 100;
      lordo = C * (Math.pow(1 + p.tasso / 100 * T / 12 * k, n) - 1) / k;
      if (n > 1) r.note.push('Ipotizzo ' + n + ' rinnovi da ' + periodo(T) + ' allo stesso tasso (non garantito).');
      if (fermo > 0) r.note.push('Gli ultimi ' + periodo(fermo) + ' restano senza interessi.');
    }
    chiudi(r, ctx, lordo, p.aliquota, p.bollo, 0);
    r.tassoLordo = p.tasso;
    rischio(r, ctx, p.ratingNum, 0, p.uscita, true);
    return r;
  }

  function libero(p, ctx) {
    const { C, H, Hm } = ctx;
    const r = nuovo(p);
    requisiti(p, r, ctx);
    let tasso = p.tasso, promo = p.promoMesi || 0;
    if (p.requisito === 'nuovoCliente' && !ctx.flags.nuovoCliente) {
      tasso = p.tassoDopo; promo = 0;
      r.note.push('La promozione vale solo per i nuovi clienti: calcolato al tasso base ipotizzato.');
    }
    let lordo;
    if (promo) {
      const pm = Math.min(Hm, promo) / 12;
      const inPromo = p.tetto ? Math.min(C, p.tetto) : C;
      lordo = inPromo * tasso / 100 * pm + (C - inPromo) * p.tassoDopo / 100 * pm + C * p.tassoDopo / 100 * Math.max(0, H - pm);
      if (Hm > promo) r.note.push('Dopo ' + periodo(promo) + ' il tasso scende al ' + p.tassoDopo.toLocaleString('it-IT') + '% (ipotesi).');
      if (p.tetto && C > p.tetto) r.note.push('La promo vale fino a ' + String(p.tetto).replace(/\B(?=(\d{3})+(?!\d))/g, '.') + ' €: il resto rende il tasso base.');
    } else {
      lordo = lordoAnnuo(C, tasso, H, p.aliquota);
    }
    chiudi(r, ctx, lordo, p.aliquota, p.bollo, 0);
    r.tassoLordo = tasso;
    if (p.cat !== 'conto' && !promo && H > 0.5) r.note.push('Tasso variabile: la banca può cambiarlo in qualsiasi momento.');
    rischio(r, ctx, p.ratingNum, 0, p.uscita, false);
    return r;
  }

  function etf(p, ctx) {
    const { C, H } = ctx;
    const r = nuovo(p);
    requisiti(p, r, ctx);
    const y = p.tasso - p.ter;
    const lordo = C * (Math.pow(1 + y / 100, H) - 1);
    const costi = 2 * ctx.comm + C * (p.spreadDenaroLettera || 0) / 100;
    chiudi(r, ctx, lordo, p.aliquota, p.bollo, costi);
    r.tassoLordo = y;
    rischio(r, ctx, p.ratingNum, p.duration, 'mercato', false);
    if (p.duration > 0.5) r.note.push('Senza scadenza: con tassi in rialzo del 1% il prezzo scende di circa il ' + p.duration.toLocaleString('it-IT') + '%.');
    else r.note.push('Il rendimento segue i tassi BCE giorno per giorno: non è bloccato.');
    return r;
  }

  const TIPI = { fisso, bfp, bfpInfl, vincolato, libero, etf };

  function valutaTutto(dati, ctx, extra) {
    ctx = Object.assign({}, ctx, { H: ctx.Hm / 12 });
    const out = [];
    for (const c of dati.curve) out.push(curva(c, ctx));
    for (const p of dati.prodotti.concat(extra || [])) {
      const fn = TIPI[p.tipo];
      if (fn) out.push(fn(p, ctx));
    }
    for (const r of out) {
      if (r.escluso) continue;
      r.punteggio = r.nettoAnnuo - LAMBDA[ctx.profilo] * Math.pow(Math.max(0, r.rischioPunti - 1), 1.5) - liqPen(r.uscita, ctx.need, r.duration || 0);
    }
    const validi = out.filter(r => !r.escluso).sort((a, b) => b.punteggio - a.punteggio);
    const esclusi = out.filter(r => r.escluso);
    const pool = validi.filter(r => r.cat !== 'conto');
    const best = pool[0] || validi[0];
    const piuSicuro = pool.slice().sort((a, b) => a.rischioPunti - b.rischioPunti || b.nettoAnnuo - a.nettoAnnuo)[0];
    const piuLiquido = pool.filter(r => r.uscita === 'libera').sort((a, b) => b.nettoAnnuo - a.nettoAnnuo)[0];
    const piuRende = pool.slice().sort((a, b) => b.nettoAnnuo - a.nettoAnnuo)[0];
    let mix = null;
    if (ctx.need === 1 && best && best.uscita !== 'libera' && piuLiquido) {
      const q = 0.3;
      const a = valutaUno(dati, Object.assign({}, ctx, { C: ctx.C * q }), piuLiquido.id, extra);
      const b = valutaUno(dati, Object.assign({}, ctx, { C: ctx.C * (1 - q) }), best.id, extra);
      if (a && b && !a.escluso && !b.escluso) {
        const netto = a.netto + b.netto;
        mix = { q, liquido: a, resto: b, netto, nettoAnnuo: (Math.pow((ctx.C + netto) / ctx.C, 1 / ctx.H) - 1) * 100 };
      }
    }
    return { ctx, validi, esclusi, best, piuSicuro, piuLiquido, piuRende, mix };
  }

  function valutaUno(dati, ctx, id, extra) {
    ctx = Object.assign({}, ctx, { H: ctx.Hm / 12 });
    if (id.startsWith('curva-')) {
      const c = dati.curve.find(x => 'curva-' + x.id === id);
      return c ? curva(c, ctx) : null;
    }
    const p = dati.prodotti.concat(extra || []).find(x => x.id === id);
    return p && TIPI[p.tipo] ? TIPI[p.tipo](p, ctx) : null;
  }

  return { valutaTutto, periodo, USCITA };
})();
if (typeof module !== 'undefined') module.exports = Motore;
