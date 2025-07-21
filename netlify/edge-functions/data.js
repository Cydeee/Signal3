// netlify/edge-functions/data.js

export default async function handler(request) {
  try {
    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin":  "*",
          "Access-Control-Allow-Methods": "GET, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type"
        }
      });
    }

    const SYMBOL = "BTCUSDT";
    const LIMIT  = 250;

    // Simple JSON fetcher
    async function safeJson(url) {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      return await res.json();
    }

    // Indicator helpers
    const sma = (arr, p) => {
      const slice = arr.slice(-p);
      return slice.reduce((sum, x) => sum + x, 0) / p;
    };

    const std = (arr, p) => {
      const slice = arr.slice(-p);
      const m = sma(slice, p);
      const variance = slice.reduce((sum, x) => sum + (x - m) ** 2, 0) / p;
      return Math.sqrt(variance);
    };

    const ema = (arr, p) => {
      if (arr.length < p) return 0;
      const k = 2 / (p + 1);
      let e = sma(arr.slice(0, p), p);
      for (let i = p; i < arr.length; i++) {
        e = arr[i] * k + e * (1 - k);
      }
      return e;
    };

    function rsi(arr, p) {
      if (arr.length < p + 1) return 0;
      let gains = 0;
      let losses = 0;
      for (let i = 1; i <= p; i++) {
        const delta = arr[i] - arr[i - 1];
        if (delta >= 0) gains += delta;
        else losses -= delta;
      }
      let avgG = gains / p;
      let avgL = losses / p;
      for (let i = p + 1; i < arr.length; i++) {
        const delta = arr[i] - arr[i - 1];
        avgG = (avgG * (p - 1) + Math.max(delta, 0)) / p;
        avgL = (avgL * (p - 1) + Math.max(-delta, 0)) / p;
      }
      return avgL === 0 ? 100 : 100 - 100 / (1 + avgG / avgL);
    }

    const atr = (high, low, close, p) => {
      if (high.length < p + 1) return 0;
      const trs = [];
      for (let i = 1; i < high.length; i++) {
        const tr = Math.max(
          high[i] - low[i],
          Math.abs(high[i] - close[i - 1]),
          Math.abs(low[i]  - close[i - 1])
        );
        trs.push(tr);
      }
      return sma(trs.slice(-p), p);
    };

    // Build result
    const result = {
      dataA: {},
      dataB: {},
      dataC: {},
      dataD: null,
      dataE: null,
      dataF: null,
      errors: []
    };

    // ── BLOCK A: Trend & Volatility ─────────────────────
    for (const tf of ["15m", "1h", "4h", "1d"]) {
      try {
        const klines = await safeJson(
          `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=${LIMIT}`
        );
        if (!Array.isArray(klines)) {
          throw new Error("klines not array");
        }
        const closes = klines.map(r => +r[4]);
        const highs  = klines.map(r => +r[2]);
        const lows   = klines.map(r => +r[3]);
        const last   = closes[closes.length - 1] || 1;

        result.dataA[tf] = {
          ema50:  +ema(closes, 50).toFixed(2),
          ema200: +ema(closes, 200).toFixed(2),
          rsi14:  +rsi(closes, 14).toFixed(1),
          bbPct:  +((4 * std(closes, 20) / last) * 100).toFixed(2),
          atrPct: +((atr(highs, lows, closes, 14) / last) * 100).toFixed(2)
        };
      } catch (err) {
        result.errors.push(`A[${tf}]: ${err.message}`);
      }
    }

    // ── BLOCK B: Price Action ────────────────────────────
    for (const tf of ["15m", "1h", "4h", "1d"]) {
      try {
        const klines = await safeJson(
          `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=${tf}&limit=5`
        );
        if (!Array.isArray(klines) || klines.length < 5) {
          throw new Error(`klines[${tf}]`);
        }
        const closes = klines.map(r => +r[4]);
        const pct    = ((closes[closes.length - 1] - closes[0]) / closes[0]) * 100;

        let note;
        if      (pct >=  1.5) note = "strong up-move – breakout long / exit shorts";
        else if (pct >=  0.5) note = "bullish drift – long bias";
        else if (pct <= -1.5) note = "strong down-move – breakout short / exit longs";
        else if (pct <= -0.5) note = "bearish drift – short bias";
        else {
          note = closes[closes.length - 1] > closes[closes.length - 2]
            ? "range base – possible long reversal"
            : "range top – possible short reversal";
        }

        result.dataB[tf] = {
          pct:  +pct.toFixed(2),
          note
        };
      } catch (err) {
        result.errors.push(`B[${tf}]: ${err.message}`);
      }
    }

    // ── BLOCK C: Volume Flow ─────────────────────────────
    try {
      const klines = await safeJson(
        `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=1500`
      );
      if (!Array.isArray(klines)) {
        throw new Error("1m klines not array");
      }
      const nowMs   = Date.now();
      const windows = { "15m": 0.25, "1h": 1, "4h": 4, "24h": 24 };

      for (const [lbl, hrs] of Object.entries(windows)) {
        const cutoff = nowMs - hrs * 3_600_000;
        let bullVol = 0, bearVol = 0;
        for (const k of klines) {
          if (+k[0] < cutoff) continue;
          if (+k[4] >= +k[1]) bullVol += +k[5];
          else bearVol += +k[5];
        }
        result.dataC[lbl] = {
          bullVol:  +bullVol.toFixed(2),
          bearVol:  +bearVol.toFixed(2),
          totalVol: +(bullVol + bearVol).toFixed(2)
        };
      }

      // Relative volume
      const tot24 = result.dataC["24h"].totalVol;
      const base  = {
        "15m": tot24 / 96,
        "1h":  tot24 / 24,
        "4h":  tot24 / 6
      };
      result.dataC.relative = {};
      for (const lbl of ["15m", "1h", "4h"]) {
        const ratio = result.dataC[lbl].totalVol / Math.max(base[lbl], 1);
        result.dataC.relative[lbl] = 
          ratio > 2   ? "very high" :
          ratio > 1.2 ? "high" :
          ratio < 0.5 ? "low" :
                        "normal";
      }
    } catch (err) {
      result.errors.push(`C: ${err.message}`);
    }

    // ── BLOCK D: Derivatives ─────────────────────────────
    try {
      const fr = await safeJson(
        `https://fapi.binance.com/fapi/v1/fundingRate?symbol=${SYMBOL}&limit=1000`
      );
      if (!Array.isArray(fr)) {
        throw new Error("fundingRate not array");
      }
      const rates = fr.slice(-42).map(d => +d.fundingRate);
      const mean  = rates.reduce((s, x) => s + x, 0) / rates.length;
      const sd    = Math.sqrt(rates.reduce((s, x) => s + (x - mean) ** 2, 0) / rates.length);
      const z     = sd ? ((rates[rates.length - 1] - mean) / sd).toFixed(2) : "0.00";

      const oiNow  = await safeJson(
        `https://fapi.binance.com/fapi/v1/openInterest?symbol=${SYMBOL}`
      );
      const oiHist = await safeJson(
        `https://fapi.binance.com/futures/data/openInterestHist?symbol=${SYMBOL}&period=1h&limit=24`
      );
      if (typeof oiNow.openInterest !== "string" || !oiHist[0]?.sumOpenInterest) {
        throw new Error("OI shape unexpected");
      }
      const pct24h = (
        ((+oiNow.openInterest - +oiHist[0].sumOpenInterest) /
          +oiHist[0].sumOpenInterest) *
        100
      ).toFixed(1);

      result.dataD = { fundingZ: z, oiDelta24h: pct24h };
    } catch (err) {
      result.errors.push(`D: ${err.message}`);
    }

    // ── BLOCK E: Sentiment ───────────────────────────────
    try {
      const cg = await safeJson(
        `https://api.coingecko.com/api/v3/coins/bitcoin`
      );
      const up = cg.sentiment_votes_up_percentage ??
                 cg.community_data?.sentiment_votes_up_percentage;
      if (up == null) {
        throw new Error("sentiment missing");
      }

      const fg = await safeJson(
        `https://api.alternative.me/fng/?limit=1`
      );
      const fgd = fg.data?.[0];
      if (!fgd) {
        throw new Error("FNG missing");
      }

      result.dataE = {
        sentimentUpPct: +up.toFixed(1),
        fearGreed:      `${fgd.value} · ${fgd.value_classification}`
      };
    } catch (err) {
      result.errors.push(`E: ${err.message}`);
    }

    // ── BLOCK F: Macro Context ────────────────────────────
    try {
      const gv = await safeJson(
        `https://api.coingecko.com/api/v3/global`
      );
      const g  = gv.data;
      if (!g?.total_market_cap?.usd) {
        throw new Error("global missing");
      }

      result.dataF = {
        totalMcapT:   +((g.total_market_cap.usd) / 1e12).toFixed(2),
        mcap24hPct:   +g.market_cap_change_percentage_24h_usd.toFixed(2),
        btcDominance: +g.market_cap_percentage.btc.toFixed(2),
        ethDominance: +g.market_cap_percentage.eth.toFixed(2)
      };
    } catch (err) {
      result.errors.push(`F: ${err.message}`);
    }

    // Return JSON
    return new Response(
      JSON.stringify({ ...result, timestamp: Date.now() }),
      {
        headers: { "Content-Type": "application/json" }
      }
    );
  }
  catch (err) {
    console.error("Edge function error:", err);
    return new Response(
      JSON.stringify({ error: "Service temporarily unavailable." }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" }
      }
    );
  }
}
