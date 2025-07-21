// netlify/edge-functions/data.js

export default async function handler(request) {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin':  '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      }
    });
  }

  const SYMBOL = 'BTCUSDT';
  const LIMIT  = 250;

  const result = {
    dataA: {},   // Trend & Volatility
    dataB: {},   // Price Action
    dataC: {},   // Volume Flow
    dataD: null, // Derivatives
    dataE: null, // Sentiment
    dataF: null, // Macro
    errors: []
  };

  // resilient JSON fetch
  async function safeJson(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
      const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
      const ct  = res.headers.get('content-type') || '';
      if (!ct.includes('application/json')) {
        await new Promise(r=>setTimeout(r,400));
        continue;
      }
      try {
        const obj = await res.json();
        if (obj && typeof obj.code === 'number' && obj.code < 0) {
          await new Promise(r=>setTimeout(r,400));
          continue;
        }
        return obj;
      } catch {
        await new Promise(r=>setTimeout(r,400));
      }
    }
    throw new Error('invalid JSON after retries');
  }

  // indicator helpers
  const sma = (a,p) => a.slice(-p).reduce((s,x)=>s+x,0)/p;
  const std = (a,p) => {
    const slice = a.slice(-p);
    const m     = sma(slice,p);
    return Math.sqrt(slice.reduce((t,x)=>t+(x-m)**2,0)/p);
  };
  const ema = (a,p) => {
    if (a.length < p) return 0;
    const k = 2/(p+1);
    let e   = sma(a.slice(0,p),p);
    for (let i=p; i<a.length; i++) e = a[i]*k + e*(1-k);
    return e;
  };
  function rsi(a,p) {
    if (a.length < p+1) return 0;
    let gains=0, losses=0;
    for (let i=1; i<=p; i++) {
      const d = a[i] - a[i-1];
      if (d >= 0) gains += d; else losses -= d;
    }
    let avgG = gains/p, avgL = losses/p;
    for (let i=p+1; i<a.length; i++) {
      const d = a[i] - a[i-1];
      avgG = (avgG*(p-1) + Math.max(d,0))/p;
      avgL = (avgL*(p-1) + Math.max(-d,0))/p;
    }
    return avgL === 0 ? 100 : 100 - 100/(1 + avgG/avgL);
  }
  const atr = (h,l,c,p) => {
    if (h.length < p+1) return 0;
    const trs = [];
    for (let i=1; i<h.length; i++) {
      trs.push(Math.max(
        h[i] - l[i],
        Math.abs(h[i] - c[i-1]),
        Math.abs(l[i] - c[i-1])
      ));
    }
    return sma(trs.slice(-p), p);
  };

  // BLOC A: Trend & Volatility
  for (const tf of ['15m','1h','4h','1d']) {
    try {
      const rows = await safeJson(
        `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${LIMIT}`
      );
      if (!Array.isArray(rows)) throw new Error('klines not array');
      const c    = rows.map(r=>+r[4]);
      const h    = rows.map(r=>+r[2]);
      const l    = rows.map(r=>+r[3]);
      const last = c.at(-1) || 1;
      result.dataA[tf] = {
        ema50:  +ema(c,50).toFixed(2),
        ema200: +ema(c,200).toFixed(2),
        rsi14:  +rsi(c,14).toFixed(1),
        bbPct:  +((4*std(c,20)/last)*100).toFixed(2),
        atrPct: +((atr(h,l,c,14)/last)*100).toFixed(2)
      };
    } catch (e) {
      result.errors.push(`A[${tf}]: ${e.message}`);
    }
  }

  // BLOC B: Price Action
  for (const tf of ['15m','1h','4h','1d']) {
    try {
      const rows = await safeJson(
        `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=5}`
      );
      if (!Array.isArray(rows) || rows.length < 5) throw new Error(`klines[${tf}]`);
      const closes = rows.map(r=>+r[4]);
      const pct    = ((closes.at(-1) - closes[0]) / closes[0]) * 100;
      let note;
      if      (pct >= 1.5)  note = 'strong up-move – breakout long / exit shorts';
      else if (pct >= 0.5)  note = 'bullish drift – long bias';
      else if (pct <= -1.5) note = 'strong down-move – breakout short / exit longs';
      else if (pct <= -0.5) note = 'bearish drift – short bias';
      else                   note = closes.at(-1) > closes.at(-2)
                               ? 'range base – possible long reversal'
                               : 'range top – possible short reversal';
      result.dataB[tf] = { pct:+pct.toFixed(2), note };
    } catch (e) {
      result.errors.push(`B[${tf}]: ${e.message}`);
    }
  }

  // BLOC C: Volume Flow
  try {
    const rows = await safeJson(
      `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=1500}`
    );
    if (!Array.isArray(rows)) throw new Error('1m klines not array');
    const now = Date.now();
    const windows = { '15m':0.25, '1h':1, '4h':4, '24h':24 };
    for (const [lbl,hrs] of Object.entries(windows)) {
      const cut = now - hrs * 3600_000;
      let bull=0, bear=0;
      for (const k of rows) {
        if (+k[0] < cut) continue;
        if (+k[4] >= +k[1]) bull += +k[5]; else bear += +k[5];
      }
      result.dataC[lbl] = { bullVol:+bull.toFixed(2), bearVol:+bear.toFixed(2), totalVol:+(bull+bear).toFixed(2) };
    }
    const tot24 = result.dataC['24h'].totalVol;
    const base  = { '15m':tot24/96, '1h':tot24/24, '4h':tot24/6 };
    result.dataC.relative = {};
    for (const lbl of ['15m','1h','4h']) {
      const r = result.dataC[lbl].totalVol / Math.max(base[lbl],1);
      if      (r > 2)   result.dataC.relative[lbl] = 'very high';
      else if (r > 1.2) result.dataC.relative[lbl] = 'high';
      else if (r < 0.5) result.dataC.relative[lbl] = 'low';
      else               result.dataC.relative[lbl] = 'normal';
    }
  } catch (e) {
    result.errors.push(`C: ${e.message}`);
  }

  // BLOC D: Derivatives
  try {
    const fr = await safeJson(`https://fapi.binance.com/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=1000}`);
    if (!Array.isArray(fr)) throw new Error('fundingRate not array');
    const arr  = fr.slice(-42).map(d=>+d.fundingRate);
    const mean = sma(arr,arr.length);
    const sd   = Math.sqrt(arr.reduce((t,x)=>t+(x-mean)**2,0)/arr.length);
    const z    = sd ? ((arr.at(-1)-mean)/sd).toFixed(2) : '0.00';

    const oiNow  = await safeJson(`https://fapi.binance.com/fapi/v1/openInterest?symbol=${SYMBOL}`);
    const oiHist = await safeJson(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${SYMBOL}&period=1h&limit=24}`);
    if (!oiNow.openInterest || !oiHist[0] || !oiHist[0].sumOpenInterest) throw new Error('OI shape unexpected');
    const pct24h = (((+oiNow.openInterest - +oiHist[0].sumOpenInterest) / +oiHist[0].sumOpenInterest)*100).toFixed(1);
    result.dataD = { fundingZ:z, oiDelta24h:pct24h };
  } catch (e) {
    result.errors.push(`D: ${e.message}`);
  }

  // BLOC E: Sentiment
  try {
    const cg  = await safeJson(`https://api.coingecko.com/api/v3/coins/bitcoin}`);
    const up  = cg.sentiment_votes_up_percentage != null
              ? cg.sentiment_votes_up_percentage
              : cg.community_data && cg.community_data.sentiment_votes_up_percentage;
    if (up == null) throw new Error('sentiment missing');
    const fg  = await safeJson(`https://api.alternative.me/fng/?limit=1}`);
    const fgd = fg.data && fg.data[0];
    if (!fgd) throw new Error('FNG missing');
    result.dataE = { sentimentUpPct:+up.toFixed(1), fearGreed:`${fgd.value} · ${fgd.value_classification}` };
  } catch (e) {
    result.errors.push(`E: ${e.message}`);
  }

  // BLOC F: Macro Context
  try {
    const gv = await safeJson(`https://api.coingecko.com/api/v3/global}`);
    if (!gv.data || !gv.data.total_market_cap || !gv.data.total_market_cap.usd) throw new Error('global missing');
    const g = gv.data;
    result.dataF = { totalMcapT:+(g.total_market_cap.usd/1e12).toFixed(2), mcap24hPct:+g.market_cap_change_percentage_24h_usd.toFixed(2), btcDominance:+g.market_cap_percentage.btc.toFixed(2), ethDominance:+g.market_cap_percentage.eth.toFixed(2) };
  } catch (e) {
    result.errors.push(`F: ${e.message}`);
  }

  // Wrap JSON in HTML
  const html = `<!DOCTYPE html>\n<html><body>\n<pre id="dashboard-data">${JSON.stringify(result)}</pre>\n</body></html>`;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
