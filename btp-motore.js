/* Motore BTP: rateo, cedole, rendimento a scadenza, tasse, vendita anticipata, pareggio, scenari di prezzo */
const BTP = (() => {
  const TAX = 0.125, BOLLO = 0.002, DAY = 86400000;
  const MESI = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic'];

  /* --- date (UTC, niente fusi orari) --- */
  const D = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  const iso = t => new Date(t).toISOString().slice(0, 10);
  const giorni = (a, b) => Math.round((b - a) / DAY);
  function addMesi(t, n) {
    const d = new Date(t), y = d.getUTCFullYear(), m = d.getUTCMonth() + n, g = d.getUTCDate();
    const ultimo = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(g, ultimo));
  }
  function regolamento(t) { // T+2 giorni lavorativi
    let r = t, n = 0;
    while (n < 2) { r += DAY; const w = new Date(r).getUTCDay(); if (w !== 0 && w !== 6) n++; }
    return r;
  }
  const dataIt = t => { const d = new Date(t); return d.getUTCDate() + ' ' + MESI[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); };

  /* --- cedole --- */
  // date di stacco a ritroso dalla scadenza, semestrali
  function calendario(b) {
    const scad = D(b.scadenza), date = [];
    for (let k = 0; ; k++) {
      const t = addMesi(scad, -6 * k);
      date.unshift(t);
      if (t < D('1990-01-01') || k > 200) break;
    }
    return date; // la prima è sempre nel passato remoto
  }
  // periodo di cedola che contiene la data t: [inizio, fine]
  function periodo(b, t) {
    const cal = calendario(b);
    for (let i = 1; i < cal.length; i++) if (cal[i - 1] <= t && t < cal[i]) return [cal[i - 1], cal[i]];
    return [cal[cal.length - 2], cal[cal.length - 1]];
  }
  // rateo lordo per 100 di nominale alla data di regolamento t (Act/Act ICMA)
  function rateo(b, t) {
    if (t >= D(b.scadenza)) return 0;
    const [ini, fin] = periodo(b, t);
    const god = b.godimento ? D(b.godimento) : null;
    const da = god && god > ini ? god : ini;
    if (t <= da) return 0;
    return (b.cedola / 2) * giorni(da, t) / giorni(ini, fin);
  }
  // flussi futuri dopo la data t: [{t, cedola, rimborso}]
  function flussi(b, t) {
    const cal = calendario(b), god = b.godimento ? D(b.godimento) : null, out = [];
    for (let i = 1; i < cal.length; i++) {
      if (cal[i] <= t) continue;
      let c = b.cedola / 2;
      if (god && god > cal[i - 1] && god < cal[i]) c = c * giorni(god, cal[i]) / giorni(cal[i - 1], cal[i]);
      out.push({ t: cal[i], cedola: c, rimborso: i === cal.length - 1 ? 100 : 0 });
    }
    return out;
  }

  /* --- prezzo e rendimento (capitalizzazione annua, giorni/365) --- */
  function tel(b, t, y) { // prezzo tel quel (con rateo) per 100
    let p = 0;
    for (const f of flussi(b, t)) p += (f.cedola + f.rimborso) / Math.pow(1 + y, giorni(t, f.t) / 365);
    return p;
  }
  const secco = (b, t, y) => tel(b, t, y) - rateo(b, t);
  function rendimento(b, t, prezzoSecco, netto) {
    const fl = flussi(b, t), r0 = rateo(b, t);
    const costo = prezzoSecco + r0 * (netto ? 1 - TAX : 1);
    const val = y => {
      let v = 0;
      for (const f of fl) {
        let cf = f.cedola * (netto ? 1 - TAX : 1);
        if (f.rimborso) cf += 100 - (netto ? TAX * Math.max(0, 100 - prezzoSecco) : 0);
        v += cf / Math.pow(1 + y, giorni(t, f.t) / 365);
      }
      return v - costo;
    };
    let lo = -0.05, hi = 0.5;
    for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; val(m) > 0 ? lo = m : hi = m; }
    return (lo + hi) / 2;
  }
  // rendimento che produce un dato prezzo secco a una data futura
  function rendimentoDaPrezzo(b, t, prezzoSecco) {
    let lo = -0.05, hi = 0.6;
    for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; secco(b, t, m) > prezzoSecco ? lo = m : hi = m; }
    return (lo + hi) / 2;
  }

  /* --- conto economico di un'operazione --- */
  // o = {N, pAcq, tAcq (regolamento), pVend, tVend (regolamento) | null = scadenza, comm, compensa}
  function operazione(b, o) {
    const N = o.N / 100, scad = D(b.scadenza);
    const fine = o.tVend == null || o.tVend >= scad ? scad : o.tVend;
    const aScadenza = fine === scad;
    const rA = rateo(b, o.tAcq);
    const acq = {
      controvalore: o.pAcq * N,
      rateoLordo: rA * N,
      creditoRateo: rA * N * TAX,
      commissione: o.comm
    };
    acq.totale = acq.controvalore + acq.rateoLordo + acq.commissione;
    acq.costoNetto = acq.totale - acq.creditoRateo;

    const cedole = flussi(b, o.tAcq).filter(f => f.t <= fine && f.cedola > 0).map(f => ({ t: f.t, lordo: f.cedola * N, netto: f.cedola * N * (1 - TAX) }));
    const cedoleLorde = cedole.reduce((s, c) => s + c.lordo, 0);
    const cedoleNette = cedole.reduce((s, c) => s + c.netto, 0);

    const pV = aScadenza ? 100 : o.pVend;
    const rV = aScadenza ? 0 : rateo(b, fine);
    const commV = aScadenza ? 0 : o.comm;
    const ricavo = pV * N;
    const rateoIncassatoNetto = rV * N * (1 - TAX);
    const diff = ricavo - acq.controvalore - acq.commissione - commV; // plus/minus fiscale (oneri inclusi)
    const tassaPlus = diff > 0 ? diff * TAX : 0;
    const creditoMinus = diff < 0 ? -diff * TAX : 0; // valore fiscale potenziale della minusvalenza
    const anni = giorni(o.tAcq, fine) / 365;
    const bollo = BOLLO * acq.controvalore * anni;

    const interessiNetti = cedoleNette - acq.rateoLordo * (1 - TAX) + rateoIncassatoNetto;
    let netto = interessiNetti + diff - tassaPlus - bollo;
    if (o.compensa) netto += creditoMinus;
    // TIR netto: flussi reali nel tempo (cedole nette, bollo annuo, incasso finale)
    const fl = [{ a: 0, v: -acq.costoNetto }];
    for (const c of cedole) fl.push({ a: giorni(o.tAcq, c.t) / 365, v: c.netto });
    for (let k = 1; k <= Math.floor(anni); k++) fl.push({ a: k, v: -BOLLO * acq.controvalore });
    if (anni % 1 > 0) fl.push({ a: anni, v: -BOLLO * acq.controvalore * (anni % 1) });
    fl.push({ a: anni, v: ricavo + rateoIncassatoNetto - commV - tassaPlus + (o.compensa ? creditoMinus : 0) });
    let annuo = null;
    if (anni > 0.02) {
      const npv = y => fl.reduce((s, f) => s + f.v / Math.pow(1 + y, f.a), 0);
      let lo = -0.9, hi = 1;
      for (let i = 0; i < 100; i++) { const m = (lo + hi) / 2; npv(m) > 0 ? lo = m : hi = m; }
      annuo = (lo + hi) / 2 * 100;
    }
    return {
      acq, cedole, cedoleLorde, cedoleNette, tasseCedole: cedoleLorde - cedoleNette,
      rateoPagatoNetto: acq.rateoLordo * (1 - TAX), rateoIncassatoNetto, rateoVenditaLordo: rV * N,
      pV, ricavo, commV, diff, tassaPlus, creditoMinus, bollo, anni, interessiNetti,
      netto, annuo, fine, aScadenza
    };
  }

  // prezzo secco di vendita a cui chiudi a zero
  function pareggio(b, o, tVend) {
    let lo = 0, hi = 250;
    for (let i = 0; i < 60; i++) {
      const m = (lo + hi) / 2;
      operazione(b, Object.assign({}, o, { pVend: m, tVend })).netto > 0 ? hi = m : lo = m;
    }
    return (lo + hi) / 2;
  }

  /* --- scenari di prezzo: rendimento che oscilla con la volatilità storica --- */
  const KAPPA = 0.15; // tendenza a tornare verso la media (anni^-1)
  function devStd(sigma, anni) {
    return sigma * Math.sqrt((1 - Math.exp(-2 * KAPPA * anni)) / (2 * KAPPA));
  }
  function Phi(x) { // normale standard cumulata
    const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2);
    const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
    return x > 0 ? 1 - p : p;
  }

  // analisi completa: o = {N, pAcq, oggi (ISO), comm, compensa, sigma (punti % annui)}
  function analizza(b, o) {
    const tAcq = regolamento(D(o.oggi)), scad = D(b.scadenza);
    const base = { N: o.N, pAcq: o.pAcq, tAcq, comm: o.comm, compensa: o.compensa };
    const y0 = rendimento(b, tAcq, o.pAcq, false);
    const y0n = rendimento(b, tAcq, o.pAcq, true);
    const scadenza = operazione(b, base);
    const sig = o.sigma / 100;
    const mesiTot = Math.max(1, Math.round(giorni(tAcq, scad) / 30.4375));
    const passo = mesiTot > 240 ? 3 : mesiTot > 120 ? 2 : 1;
    const serie = [];
    for (let m = passo; m < mesiTot; m += passo) {
      const t = addMesi(tAcq, m);
      if (t >= scad) break;
      const a = giorni(tAcq, t) / 365, sd = devStd(sig, a);
      const be = pareggio(b, base, t);
      const yBe = rendimentoDaPrezzo(b, t, be);
      serie.push({
        m, t, be,
        invariato: secco(b, t, y0),
        p10: secco(b, t, y0 + 1.2816 * sd),
        p90: secco(b, t, Math.max(-0.01, y0 - 1.2816 * sd)),
        probGuadagno: sd > 0 ? Phi((yBe - y0) / sd) : (yBe > y0 ? 1 : 0),
        yBe
      });
    }
    serie.push({ m: mesiTot, t: scad, be: null, invariato: 100, p10: 100, p90: 100, probGuadagno: scadenza.netto > 0 ? 1 : 0, yBe: null });

    const primo = f => { const s = serie.find(f); return s ? s.m : null; };
    const shock = [0.5, 1, 2].map(dy => ({
      dy,
      mesi: primo(s => s.be == null ? scadenza.netto > 0 : secco(b, s.t, y0 + dy / 100) >= s.be),
      prezzoSubito: secco(b, tAcq, y0 + dy / 100)
    }));
    return {
      tAcq, scad, y0, y0n, scadenza, serie, mesiTot, base,
      rateoOggi: rateo(b, tAcq),
      duration: durationMod(b, tAcq, y0),
      pareggioInvariato: primo(s => s.be == null || s.invariato >= s.be),
      sicuro80: primo(s => s.probGuadagno >= 0.8),
      shock
    };
  }

  function durationMod(b, t, y) {
    let p = 0, w = 0;
    for (const f of flussi(b, t)) {
      const a = giorni(t, f.t) / 365, v = (f.cedola + f.rimborso) / Math.pow(1 + y, a);
      p += v; w += a * v;
    }
    return w / p / (1 + y);
  }

  function vendita(b, an, mesi, prezzo) {
    const t = addMesi(an.tAcq, mesi);
    const op = operazione(b, Object.assign({}, an.base, { pVend: prezzo, tVend: t }));
    const a = giorni(an.tAcq, t) / 365;
    return {
      t, op,
      be: pareggio(b, an.base, t),
      invariato: secco(b, t, an.y0),
      sd: devStd(an.sigma || 0, a)
    };
  }

  return { analizza, vendita, operazione, pareggio, secco, rendimento, rateo, flussi, regolamento, D, iso, dataIt, addMesi, devStd, Phi, rendimentoDaPrezzo, giorni };
})();
if (typeof module !== 'undefined') module.exports = BTP;
