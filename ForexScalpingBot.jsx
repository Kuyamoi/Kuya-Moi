import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, ComposedChart, Area
} from "recharts";
import {
  Activity, TrendingUp, TrendingDown, Zap, Play, Pause,
  RotateCcw, Settings, ArrowUpRight, ArrowDownRight, Wifi
} from "lucide-react";

/* ============================================================
   FOREX SCALPING BOT
   Strategy: EMA(9)/EMA(21) crossover confirmed by Stochastic
   Quant engine + live tick simulation (data source swappable)
   ============================================================ */

// ---------- Indicator math ----------
function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev;
  for (let i = 0; i < values.length; i++) {
    if (i === 0) { prev = values[0]; }
    else { prev = values[i] * k + prev * (1 - k); }
    out.push(prev);
  }
  return out;
}

function stochastic(candles, kPeriod = 14, dPeriod = 3) {
  const kArr = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < kPeriod - 1) { kArr.push(null); continue; }
    let hi = -Infinity, lo = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hi = Math.max(hi, candles[j].high);
      lo = Math.min(lo, candles[j].low);
    }
    const c = candles[i].close;
    kArr.push(hi === lo ? 50 : ((c - lo) / (hi - lo)) * 100);
  }
  const dArr = kArr.map((_, i) => {
    if (i < kPeriod - 1 + dPeriod - 1) return null;
    const slice = kArr.slice(i - dPeriod + 1, i + 1);
    if (slice.some((v) => v === null)) return null;
    return slice.reduce((a, b) => a + b, 0) / dPeriod;
  });
  return { k: kArr, d: dArr };
}

// ---------- Market tick engine (geometric Brownian + drift regimes) ----------
function makeMarket(seedPrice) {
  let price = seedPrice;
  let drift = 0;
  let regimeTtl = 0;
  return function next(dt = 1) {
    if (regimeTtl <= 0) {
      drift = (Math.random() - 0.5) * 0.00008;
      regimeTtl = 30 + Math.floor(Math.random() * 120);
    }
    regimeTtl--;
    const vol = 0.00022;
    const shock = (Math.random() - 0.5) * 2;
    price = price * (1 + drift * dt + vol * shock * Math.sqrt(dt));
    return price;
  };
}

const PAIRS = {
  "EUR/USD": 1.0856, "GBP/USD": 1.2712, "USD/JPY": 156.42,
  "AUD/USD": 0.6634, "USD/CHF": 0.8951,
};

const fmt = (p, pair) => p.toFixed(pair === "USD/JPY" ? 3 : 5);
const pipSize = (pair) => (pair === "USD/JPY" ? 0.01 : 0.0001);

export default function ForexScalpingBot() {
  const [pair, setPair] = useState("EUR/USD");
  const [running, setRunning] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [showSettings, setShowSettings] = useState(false);

  const [cfg, setCfg] = useState({
    emaFast: 9, emaSlow: 21, stochK: 14, stochD: 3,
    stochOB: 80, stochOS: 20, tpPips: 8, slPips: 6, riskPct: 1,
  });

  const [candles, setCandles] = useState([]);
  const [signals, setSignals] = useState([]);
  const [position, setPosition] = useState(null); // {dir, entry, tp, sl, time}
  const [trades, setTrades] = useState([]);
  const [balance, setBalance] = useState(10000);
  const [tick, setTick] = useState(0);

  const marketRef = useRef(makeMarket(PAIRS[pair]));
  const builderRef = useRef({ o: PAIRS[pair], h: PAIRS[pair], l: PAIRS[pair], c: PAIRS[pair], n: 0 });

  // reset when pair changes
  useEffect(() => {
    marketRef.current = makeMarket(PAIRS[pair]);
    builderRef.current = { o: PAIRS[pair], h: PAIRS[pair], l: PAIRS[pair], c: PAIRS[pair], n: 0 };
    setCandles([]); setSignals([]); setPosition(null); setTrades([]);
    setBalance(10000); setTick(0);
  }, [pair]);

  // ---------- main loop ----------
  useEffect(() => {
    if (!running) return;
    const TICKS_PER_CANDLE = 8;
    const id = setInterval(() => {
      const px = marketRef.current(1);
      const b = builderRef.current;
      b.c = px; b.h = Math.max(b.h, px); b.l = Math.min(b.l, px); b.n++;
      setTick((t) => t + 1);

      if (b.n >= TICKS_PER_CANDLE) {
        const candle = {
          time: Date.now(), open: b.o, high: b.h, low: b.l, close: b.c,
        };
        builderRef.current = { o: px, h: px, l: px, c: px, n: 0 };
        setCandles((prev) => {
          const next = [...prev, candle].slice(-200);
          evaluate(next, px);
          return next;
        });
      } else {
        // intra-candle: check open position against live price
        setCandles((prev) => { manageOpen(px); return prev; });
      }
    }, 300 / speed);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, speed, cfg, position]);

  // ---------- position management ----------
  const manageOpen = useCallback((px) => {
    setPosition((pos) => {
      if (!pos) return pos;
      const hitTp = pos.dir === "LONG" ? px >= pos.tp : px <= pos.tp;
      const hitSl = pos.dir === "LONG" ? px <= pos.sl : px >= pos.sl;
      if (hitTp || hitSl) {
        const exit = hitTp ? pos.tp : pos.sl;
        closeTrade(pos, exit, hitTp ? "TP" : "SL");
        return null;
      }
      return pos;
    });
  }, []);

  const closeTrade = useCallback((pos, exit, reason) => {
    const ps = pipSize(pair);
    const pips = ((pos.dir === "LONG" ? exit - pos.entry : pos.entry - exit) / ps);
    const risk = (balance * cfg.riskPct) / 100;
    const pnl = (pips / cfg.slPips) * risk;
    setBalance((bal) => +(bal + pnl).toFixed(2));
    setTrades((t) => [
      { id: Date.now() + Math.random(), pair, dir: pos.dir, entry: pos.entry,
        exit, pips: +pips.toFixed(1), pnl: +pnl.toFixed(2), reason,
        time: new Date().toLocaleTimeString() },
      ...t,
    ].slice(0, 60));
  }, [pair, balance, cfg]);

  // ---------- strategy evaluation ----------
  const evaluate = useCallback((cs, livePx) => {
    manageOpen(livePx);
    if (cs.length < cfg.emaSlow + cfg.stochK + cfg.stochD) return;
    const closes = cs.map((c) => c.close);
    const ef = ema(closes, cfg.emaFast);
    const es = ema(closes, cfg.emaSlow);
    const { k, d } = stochastic(cs, cfg.stochK, cfg.stochD);
    const i = cs.length - 1;

    const crossUp = ef[i - 1] <= es[i - 1] && ef[i] > es[i];
    const crossDn = ef[i - 1] >= es[i - 1] && ef[i] < es[i];
    const kNow = k[i], dNow = d[i];
    if (kNow == null || dNow == null) return;

    let sig = null;
    if (crossUp && kNow < cfg.stochOB && kNow >= dNow) sig = "LONG";
    else if (crossDn && kNow > cfg.stochOS && kNow <= dNow) sig = "SHORT";

    if (sig) {
      setSignals((s) => [
        { time: cs[i].time, type: sig, price: cs[i].close,
          k: +kNow.toFixed(1), d: +dNow.toFixed(1) }, ...s,
      ].slice(0, 40));

      setPosition((pos) => {
        if (pos) return pos; // one position at a time
        const ps = pipSize(pair);
        const entry = cs[i].close;
        const tp = sig === "LONG" ? entry + cfg.tpPips * ps : entry - cfg.tpPips * ps;
        const sl = sig === "LONG" ? entry - cfg.slPips * ps : entry + cfg.slPips * ps;
        return { dir: sig, entry, tp, sl, time: cs[i].time };
      });
    }
  }, [cfg, pair, manageOpen]);

  // ---------- derived chart data ----------
  const chart = useMemo(() => {
    if (candles.length < 2) return [];
    const closes = candles.map((c) => c.close);
    const ef = ema(closes, cfg.emaFast);
    const es = ema(closes, cfg.emaSlow);
    const { k, d } = stochastic(candles, cfg.stochK, cfg.stochD);
    return candles.map((c, i) => ({
      i, price: +c.close.toFixed(5),
      emaFast: +ef[i].toFixed(5), emaSlow: +es[i].toFixed(5),
      k: k[i] == null ? null : +k[i].toFixed(1),
      d: d[i] == null ? null : +d[i].toFixed(1),
    }));
  }, [candles, cfg]);

  const stats = useMemo(() => {
    const wins = trades.filter((t) => t.pnl > 0).length;
    const total = trades.length;
    const pnlSum = trades.reduce((a, t) => a + t.pnl, 0);
    const pipSum = trades.reduce((a, t) => a + t.pips, 0);
    return {
      total, wins, losses: total - wins,
      winRate: total ? ((wins / total) * 100).toFixed(1) : "0.0",
      pnl: pnlSum.toFixed(2), pips: pipSum.toFixed(1),
    };
  }, [trades]);

  const livePrice = candles.length ? candles[candles.length - 1].close : PAIRS[pair];
  const unrealized = position
    ? (((position.dir === "LONG" ? livePrice - position.entry : position.entry - livePrice) /
        pipSize(pair))).toFixed(1)
    : null;

  return (
    <div style={S.app}>
      <style>{CSS}</style>

      {/* Header */}
      <header style={S.header}>
        <div style={S.brand}>
          <div style={S.logoBox}><Zap size={20} color="#0a0e0a" /></div>
          <div>
            <div style={S.title}>SCALPER<span style={{ color: "#3ddc84" }}>/</span>X</div>
            <div style={S.subtitle}>EMA 9/21 × STOCHASTIC ENGINE</div>
          </div>
        </div>
        <div style={S.headerRight}>
          <div style={S.liveBadge}>
            <Wifi size={13} className={running ? "pulse" : ""} />
            <span>{running ? "LIVE FEED" : "PAUSED"}</span>
          </div>
          <select value={pair} onChange={(e) => setPair(e.target.value)} style={S.select}>
            {Object.keys(PAIRS).map((p) => <option key={p}>{p}</option>)}
          </select>
        </div>
      </header>

      <div style={S.priceBar}>
        <div style={S.bigPrice}>
          <span style={S.pairLabel}>{pair}</span>
          <span className="ticker">{fmt(livePrice, pair)}</span>
        </div>
        <div style={S.controls}>
          <button style={{ ...S.btn, ...(running ? S.btnPause : S.btnPlay) }}
            onClick={() => setRunning((r) => !r)}>
            {running ? <Pause size={15} /> : <Play size={15} />}
            {running ? "PAUSE" : "START BOT"}
          </button>
          <div style={S.speedGroup}>
            {[1, 2, 4].map((s) => (
              <button key={s} onClick={() => setSpeed(s)}
                style={{ ...S.speedBtn, ...(speed === s ? S.speedActive : {}) }}>{s}×</button>
            ))}
          </div>
          <button style={S.iconBtn} onClick={() => setShowSettings((v) => !v)}><Settings size={15} /></button>
          <button style={S.iconBtn} onClick={() => {
            setCandles([]); setSignals([]); setPosition(null);
            setTrades([]); setBalance(10000); setTick(0);
            marketRef.current = makeMarket(PAIRS[pair]);
          }}><RotateCcw size={15} /></button>
        </div>
      </div>

      {showSettings && (
        <div style={S.settings}>
          {[
            ["emaFast", "EMA Fast"], ["emaSlow", "EMA Slow"],
            ["stochK", "Stoch %K"], ["stochD", "Stoch %D"],
            ["stochOB", "Overbought"], ["stochOS", "Oversold"],
            ["tpPips", "TP (pips)"], ["slPips", "SL (pips)"], ["riskPct", "Risk %"],
          ].map(([key, label]) => (
            <label key={key} style={S.setItem}>
              <span style={S.setLabel}>{label}</span>
              <input type="number" value={cfg[key]}
                onChange={(e) => setCfg((c) => ({ ...c, [key]: +e.target.value }))}
                style={S.setInput} />
            </label>
          ))}
        </div>
      )}

      {/* Stat strip */}
      <div style={S.statStrip}>
        <Stat label="BALANCE" value={`$${balance.toLocaleString()}`} accent />
        <Stat label="NET P/L" value={`$${stats.pnl}`} pos={+stats.pnl > 0} neg={+stats.pnl < 0} />
        <Stat label="PIPS" value={stats.pips} pos={+stats.pips > 0} neg={+stats.pips < 0} />
        <Stat label="WIN RATE" value={`${stats.winRate}%`} />
        <Stat label="TRADES" value={stats.total} />
        <Stat label="W / L" value={`${stats.wins} / ${stats.losses}`} />
      </div>

      <div style={S.grid}>
        {/* Charts */}
        <div style={S.chartCol}>
          <div style={S.card}>
            <div style={S.cardHead}>
              <span><Activity size={14} /> PRICE · EMA {cfg.emaFast}/{cfg.emaSlow}</span>
              <Legend />
            </div>
            <ResponsiveContainer width="100%" height={300}>
              <ComposedChart data={chart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="pg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#3ddc84" stopOpacity={0.18} />
                    <stop offset="100%" stopColor="#3ddc84" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#1a2620" strokeDasharray="2 4" />
                <XAxis dataKey="i" hide />
                <YAxis domain={["auto", "auto"]} tick={{ fill: "#5a6b60", fontSize: 10 }}
                  width={62} tickFormatter={(v) => v.toFixed(pair === "USD/JPY" ? 2 : 4)} />
                <Tooltip content={<ChartTip pair={pair} />} />
                <Area type="monotone" dataKey="price" stroke="none" fill="url(#pg)" />
                <Line type="monotone" dataKey="price" stroke="#e8f5ee" dot={false} strokeWidth={1.4} isAnimationActive={false} />
                <Line type="monotone" dataKey="emaFast" stroke="#3ddc84" dot={false} strokeWidth={1.6} isAnimationActive={false} />
                <Line type="monotone" dataKey="emaSlow" stroke="#ff9e3d" dot={false} strokeWidth={1.6} isAnimationActive={false} />
                {position && <ReferenceLine y={position.entry} stroke="#5a9bff" strokeDasharray="4 3" />}
                {position && <ReferenceLine y={position.tp} stroke="#3ddc84" strokeDasharray="4 3" />}
                {position && <ReferenceLine y={position.sl} stroke="#ff5470" strokeDasharray="4 3" />}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          <div style={S.card}>
            <div style={S.cardHead}>
              <span><Activity size={14} /> STOCHASTIC {cfg.stochK},{cfg.stochD}</span>
            </div>
            <ResponsiveContainer width="100%" height={150}>
              <LineChart data={chart} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="#1a2620" strokeDasharray="2 4" />
                <XAxis dataKey="i" hide />
                <YAxis domain={[0, 100]} ticks={[0, 20, 50, 80, 100]}
                  tick={{ fill: "#5a6b60", fontSize: 10 }} width={62} />
                <Tooltip content={<ChartTip pair={pair} stoch />} />
                <ReferenceLine y={cfg.stochOB} stroke="#ff5470" strokeDasharray="3 3" />
                <ReferenceLine y={cfg.stochOS} stroke="#3ddc84" strokeDasharray="3 3" />
                <Line type="monotone" dataKey="k" stroke="#5a9bff" dot={false} strokeWidth={1.5} isAnimationActive={false} />
                <Line type="monotone" dataKey="d" stroke="#ff9e3d" dot={false} strokeWidth={1.3} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Side panel */}
        <div style={S.sideCol}>
          <div style={S.card}>
            <div style={S.cardHead}><span>OPEN POSITION</span></div>
            {position ? (
              <div style={S.posBox}>
                <div style={{
                  ...S.posDir,
                  background: position.dir === "LONG" ? "rgba(61,220,132,.12)" : "rgba(255,84,112,.12)",
                  color: position.dir === "LONG" ? "#3ddc84" : "#ff5470",
                }}>
                  {position.dir === "LONG" ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}
                  {position.dir}
                </div>
                <PosRow label="Entry" value={fmt(position.entry, pair)} />
                <PosRow label="Take Profit" value={fmt(position.tp, pair)} color="#3ddc84" />
                <PosRow label="Stop Loss" value={fmt(position.sl, pair)} color="#ff5470" />
                <PosRow label="Unrealized"
                  value={`${unrealized > 0 ? "+" : ""}${unrealized} pips`}
                  color={unrealized > 0 ? "#3ddc84" : unrealized < 0 ? "#ff5470" : "#9fb3a8"} />
              </div>
            ) : (
              <div style={S.flat}>
                <span style={{ opacity: .5 }}>● FLAT</span>
                <p style={S.flatHint}>Awaiting EMA crossover + Stochastic confirmation…</p>
              </div>
            )}
          </div>

          <div style={S.card}>
            <div style={S.cardHead}><span>SIGNAL LOG</span></div>
            <div style={S.scroll}>
              {signals.length === 0 && <div style={S.empty}>No signals yet</div>}
              {signals.map((s, i) => (
                <div key={i} style={S.sigRow}>
                  <span style={{ color: s.type === "LONG" ? "#3ddc84" : "#ff5470", fontWeight: 700 }}>
                    {s.type === "LONG" ? <TrendingUp size={13} /> : <TrendingDown size={13} />} {s.type}
                  </span>
                  <span style={S.mono}>{fmt(s.price, pair)}</span>
                  <span style={S.sigK}>K{s.k} D{s.d}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={S.card}>
            <div style={S.cardHead}><span>TRADE HISTORY</span></div>
            <div style={{ ...S.scroll, maxHeight: 220 }}>
              {trades.length === 0 && <div style={S.empty}>No closed trades</div>}
              {trades.map((t) => (
                <div key={t.id} style={S.tradeRow}>
                  <span style={{ color: t.dir === "LONG" ? "#3ddc84" : "#ff5470", fontWeight: 700, width: 46 }}>
                    {t.dir}
                  </span>
                  <span style={{ ...S.tag, color: t.reason === "TP" ? "#3ddc84" : "#ff5470" }}>{t.reason}</span>
                  <span style={{ ...S.mono, color: t.pips >= 0 ? "#3ddc84" : "#ff5470" }}>
                    {t.pips >= 0 ? "+" : ""}{t.pips}p
                  </span>
                  <span style={{ ...S.mono, color: t.pnl >= 0 ? "#3ddc84" : "#ff5470", marginLeft: "auto" }}>
                    {t.pnl >= 0 ? "+" : ""}${t.pnl}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      <footer style={S.footer}>
        SIMULATED MARKET FEED · For education only. Swap <code>makeMarket()</code> for a broker websocket (OANDA / Polygon) to go live.
      </footer>
    </div>
  );
}

// ---------- small components ----------
const Stat = ({ label, value, pos, neg, accent }) => (
  <div style={S.statCell}>
    <div style={S.statLabel}>{label}</div>
    <div style={{
      ...S.statValue,
      color: accent ? "#3ddc84" : pos ? "#3ddc84" : neg ? "#ff5470" : "#e8f5ee",
    }}>{value}</div>
  </div>
);

const PosRow = ({ label, value, color }) => (
  <div style={S.posRow}>
    <span style={{ color: "#7a8b80" }}>{label}</span>
    <span style={{ ...S.mono, color: color || "#e8f5ee" }}>{value}</span>
  </div>
);

const Legend = () => (
  <div style={{ display: "flex", gap: 12, fontSize: 10, color: "#7a8b80" }}>
    <span><b style={{ color: "#3ddc84" }}>—</b> EMA fast</span>
    <span><b style={{ color: "#ff9e3d" }}>—</b> EMA slow</span>
  </div>
);

const ChartTip = ({ active, payload, pair, stoch }) => {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={S.tip}>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color, fontSize: 11 }}>
          {p.name}: {stoch ? p.value : fmt(p.value, pair)}
        </div>
      ))}
    </div>
  );
};

// ---------- styles ----------
const S = {
  app: { minHeight: "100vh", background: "radial-gradient(120% 100% at 50% 0%, #0d1612 0%, #060a08 60%)", color: "#e8f5ee", fontFamily: "'Space Mono', ui-monospace, monospace", padding: "0 0 40px" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "18px 24px", borderBottom: "1px solid #1a2620" },
  brand: { display: "flex", alignItems: "center", gap: 12 },
  logoBox: { width: 38, height: 38, borderRadius: 10, background: "linear-gradient(135deg,#3ddc84,#26a866)", display: "grid", placeItems: "center", boxShadow: "0 0 24px rgba(61,220,132,.4)" },
  title: { fontSize: 20, fontWeight: 700, letterSpacing: 1, fontFamily: "'Syne', sans-serif" },
  subtitle: { fontSize: 10, color: "#5a6b60", letterSpacing: 2 },
  headerRight: { display: "flex", alignItems: "center", gap: 12 },
  liveBadge: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#3ddc84", border: "1px solid #1f3329", padding: "5px 10px", borderRadius: 20 },
  select: { background: "#0e1813", color: "#e8f5ee", border: "1px solid #1f3329", borderRadius: 8, padding: "8px 10px", fontFamily: "inherit", fontSize: 13 },
  priceBar: { display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16, padding: "20px 24px" },
  bigPrice: { display: "flex", alignItems: "baseline", gap: 14 },
  pairLabel: { fontSize: 13, color: "#7a8b80", letterSpacing: 1 },
  controls: { display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" },
  btn: { display: "flex", alignItems: "center", gap: 7, border: "none", borderRadius: 8, padding: "10px 16px", fontFamily: "inherit", fontWeight: 700, fontSize: 12, cursor: "pointer", letterSpacing: .5 },
  btnPlay: { background: "#3ddc84", color: "#06140c" },
  btnPause: { background: "#ff9e3d", color: "#1a1000" },
  speedGroup: { display: "flex", border: "1px solid #1f3329", borderRadius: 8, overflow: "hidden" },
  speedBtn: { background: "transparent", color: "#7a8b80", border: "none", padding: "9px 12px", cursor: "pointer", fontFamily: "inherit", fontSize: 12 },
  speedActive: { background: "#1a2620", color: "#3ddc84" },
  iconBtn: { background: "#0e1813", color: "#9fb3a8", border: "1px solid #1f3329", borderRadius: 8, padding: 10, cursor: "pointer", display: "grid", placeItems: "center" },
  settings: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 12, margin: "0 24px 16px", padding: 16, background: "#0b130f", border: "1px solid #1a2620", borderRadius: 12 },
  setItem: { display: "flex", flexDirection: "column", gap: 5 },
  setLabel: { fontSize: 10, color: "#7a8b80", letterSpacing: 1 },
  setInput: { background: "#060a08", border: "1px solid #1f3329", borderRadius: 6, color: "#e8f5ee", padding: "7px 9px", fontFamily: "inherit", fontSize: 13 },
  statStrip: { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 1, background: "#1a2620", margin: "0 24px 20px", borderRadius: 12, overflow: "hidden", border: "1px solid #1a2620" },
  statCell: { background: "#0b130f", padding: "14px 16px" },
  statLabel: { fontSize: 10, color: "#5a6b60", letterSpacing: 1.5, marginBottom: 6 },
  statValue: { fontSize: 22, fontWeight: 700, fontFamily: "'Syne', sans-serif" },
  grid: { display: "grid", gridTemplateColumns: "minmax(0,1.9fr) minmax(0,1fr)", gap: 16, padding: "0 24px" },
  chartCol: { display: "flex", flexDirection: "column", gap: 16, minWidth: 0 },
  sideCol: { display: "flex", flexDirection: "column", gap: 16, minWidth: 0 },
  card: { background: "#0b130f", border: "1px solid #1a2620", borderRadius: 14, padding: 16 },
  cardHead: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 11, color: "#9fb3a8", letterSpacing: 1.5, marginBottom: 12, fontWeight: 700 },
  posBox: { display: "flex", flexDirection: "column", gap: 10 },
  posDir: { display: "flex", alignItems: "center", gap: 6, fontWeight: 700, padding: "8px 12px", borderRadius: 8, width: "fit-content", fontSize: 14 },
  posRow: { display: "flex", justifyContent: "space-between", fontSize: 13 },
  flat: { textAlign: "center", padding: "24px 0", color: "#7a8b80" },
  flatHint: { fontSize: 11, marginTop: 8, opacity: .6 },
  scroll: { display: "flex", flexDirection: "column", gap: 6, maxHeight: 180, overflowY: "auto" },
  sigRow: { display: "flex", alignItems: "center", gap: 10, fontSize: 12, padding: "6px 8px", background: "#0e1813", borderRadius: 6 },
  sigK: { marginLeft: "auto", color: "#5a6b60", fontSize: 10 },
  tradeRow: { display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "6px 8px", background: "#0e1813", borderRadius: 6 },
  tag: { fontSize: 10, fontWeight: 700, border: "1px solid currentColor", padding: "1px 5px", borderRadius: 4 },
  mono: { fontFamily: "'Space Mono', monospace" },
  empty: { color: "#5a6b60", fontSize: 12, textAlign: "center", padding: "16px 0" },
  tip: { background: "#0b130f", border: "1px solid #1f3329", borderRadius: 8, padding: "8px 10px" },
  footer: { textAlign: "center", color: "#5a6b60", fontSize: 11, marginTop: 28, padding: "0 24px" },
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=Space+Mono:wght@400;700&display=swap');
* { box-sizing: border-box; }
body { margin: 0; }
.ticker { font-size: 34px; font-weight: 700; font-family: 'Space Mono', monospace; letter-spacing: 1px; }
.pulse { animation: pulse 1.2s ease-in-out infinite; }
@keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .3; } }
::-webkit-scrollbar { width: 6px; }
::-webkit-scrollbar-thumb { background: #1f3329; border-radius: 3px; }
@media (max-width: 860px) {
  div[style*="1.9fr"] { grid-template-columns: 1fr !important; }
}
`;
