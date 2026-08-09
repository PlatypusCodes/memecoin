// ===========================================================
// PLATYPUS ($PLTY) — single-coin trading terminal
// ===========================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot,
  collection, query, orderBy, limit, limitToLast,
  runTransaction, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-firestore.js";

// ---------- Firebase ----------
const firebaseConfig = {
  apiKey: "AIzaSyDV3z15ypyoUC2JqoKe001-t3mUXXU9PUY",
  authDomain: "kindness-230ff.firebaseapp.com",
  projectId: "kindness-230ff",
  storageBucket: "kindness-230ff.firebasestorage.app",
  messagingSenderId: "1064201629321",
  appId: "1:1064201629321:web:e815bdb228c23402f3a058",
  measurementId: "G-M6DP59X5N3"
};
const fbApp = initializeApp(firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);

// ---------- constants ----------
const COIN_NAME = "Platypus";
const COIN_SYMBOL = "PLTY";
const TOTAL_SUPPLY = 1_000_000_000;
const STARTING_PRICE = 0.00069;
const STARTING_BALANCE = 10000;
const TICK_MS = 3000;
const GLOBAL_SEED = 90210;
const DEFAULT_AVATAR = "https://avatars.githubusercontent.com/u/298894342?s=60&v=4";
const MAX_TICK_HISTORY = 2000;

const marketRef = doc(db, "market", "state");
const ticksCol = collection(db, "ticks");
const tradesCol = collection(db, "trades");
const usersCol = collection(db, "users");

// ---------- deterministic price engine ----------
function mulberry32(seed) {
  let t = seed >>> 0;
  return function () {
    t |= 0; t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}
function seededRandom(tickIdx, salt) {
  const seed = (GLOBAL_SEED ^ Math.imul(tickIdx, 2654435761) ^ Math.imul(salt, 668265263)) >>> 0;
  return mulberry32(seed)();
}
function stepPrice(price, tickIdx) {
  const r1 = seededRandom(tickIdx, 1);
  const r2 = seededRandom(tickIdx, 2);
  const r3 = seededRandom(tickIdx, 3);
  const r4 = seededRandom(tickIdx, 4);
  let changePct;
  if (r3 < 0.012) {
    const magnitude = 0.15 + r2 * 0.35;
    const dir = r4 < 0.5 ? -1 : 1;
    changePct = dir * magnitude;
  } else {
    const drift = (r1 - 0.5) * 0.02;
    const noise = (r2 - 0.5) * 0.05;
    changePct = drift + noise;
  }
  return Math.max(price * (1 + changePct), 0.000000001);
}

// ---------- state ----------
let currentUser = null;   // { uid, username, avatarUrl, balance, holdings }
let marketState = { price: STARTING_PRICE, marketCap: STARTING_PRICE * TOTAL_SUPPLY, lastTickIndex: 0, priceOpen24h: STARTING_PRICE };
let ticks = [];            // ascending by ts
let trades = [];           // descending by ts (most recent first)
let traderMap = new Map(); // uid -> {username, avatarUrl, buys, sells, volume}
let activeTF = "live";
let hoverPoint = null;
let sheetMode = "buy";
let sheetAmount = "";

// ===========================================================
// AUTH / ONBOARDING
// ===========================================================
const el = (id) => document.getElementById(id);

function showApp() {
  el("authGate").classList.add("hidden");
  el("app").classList.remove("hidden");
}
function showOnboard() {
  el("authLoading").classList.add("hidden");
  el("onboardForm").classList.remove("hidden");
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    try { await signInAnonymously(auth); } catch (e) { authError("Could not connect: " + e.message); }
    return;
  }
  const uref = doc(usersCol, user.uid);
  const snap = await getDoc(uref);
  if (snap.exists()) {
    currentUser = { uid: user.uid, ...snap.data() };
    subscribeUser(uref);
    boot();
  } else {
    showOnboard();
    window.__pendingUserRef = uref;
  }
});

function authError(msg) {
  el("authError").textContent = msg;
}

el("avatarInput").addEventListener("input", () => {
  const v = el("avatarInput").value.trim();
  el("onboardAvatarPreview").src = v || DEFAULT_AVATAR;
});
el("onboardAvatarPreview").addEventListener("error", () => {
  el("onboardAvatarPreview").src = DEFAULT_AVATAR;
});
el("usernameInput").addEventListener("input", () => {
  const v = el("usernameInput").value.trim();
  el("onboardNamePreview").textContent = v || "anon_trader";
});

el("onboardForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = el("usernameInput").value.trim().slice(0, 18);
  if (!username) { authError("Pick a username."); return; }
  const avatarUrl = el("avatarInput").value.trim() || DEFAULT_AVATAR;
  const uref = window.__pendingUserRef;
  el("onboardSubmit").disabled = true;
  el("onboardSubmit").textContent = "Diving in…";
  try {
    const data = {
      username, avatarUrl,
      balance: STARTING_BALANCE,
      holdings: 0,
      createdAt: Date.now()
    };
    await setDoc(uref, data);
    currentUser = { uid: uref.id, ...data };
    subscribeUser(uref);
    boot();
  } catch (err) {
    authError(err.message);
    el("onboardSubmit").disabled = false;
    el("onboardSubmit").textContent = "Enter the pond";
  }
});

function subscribeUser(uref) {
  onSnapshot(uref, (snap) => {
    if (!snap.exists()) return;
    currentUser = { uid: uref.id, ...snap.data() };
    renderProfile();
    renderWallet();
    renderSheetConvert();
  });
}

// ===========================================================
// BOOT
// ===========================================================
let booted = false;
function boot() {
  if (booted) return;
  booted = true;
  showApp();
  renderProfile();
  subscribeMarket();
  subscribeTicks();
  subscribeTrades();
  startTickLoop();
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
}

// ===========================================================
// MARKET STATE
// ===========================================================
async function ensureMarketDoc() {
  const snap = await getDoc(marketRef);
  if (!snap.exists()) {
    const now = Date.now();
    await setDoc(marketRef, {
      price: STARTING_PRICE,
      marketCap: STARTING_PRICE * TOTAL_SUPPLY,
      lastTickIndex: Math.floor(now / TICK_MS),
      priceOpen24h: STARTING_PRICE,
      createdAt: now
    }).catch(() => {});
  }
}

function subscribeMarket() {
  ensureMarketDoc().finally(() => {
    onSnapshot(marketRef, (snap) => {
      if (!snap.exists()) return;
      marketState = snap.data();
      renderTopStats();
      renderVial();
      renderWallet();
      renderSheetConvert();
    });
  });
}

async function advanceTick() {
  const nowTick = Math.floor(Date.now() / TICK_MS);
  try {
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(marketRef);
      if (!snap.exists()) return;
      const data = snap.data();
      let tickIdx = data.lastTickIndex || nowTick;
      if (tickIdx >= nowTick) return;
      let price = data.price;
      const steps = Math.min(nowTick - tickIdx, 5);
      for (let i = 1; i <= steps; i++) {
        price = stepPrice(price, tickIdx + i);
      }
      tickIdx += steps;
      tx.update(marketRef, {
        price,
        marketCap: price * TOTAL_SUPPLY,
        lastTickIndex: tickIdx
      });
    });
  } catch (e) { /* contention is fine, another client advanced it */ }

  // write a tick record for charting (deterministic id, harmless overwrite)
  try {
    const freshSnap = await getDoc(marketRef);
    if (freshSnap.exists()) {
      const p = freshSnap.data().price;
      const tid = `t_${nowTick}`;
      await setDoc(doc(ticksCol, tid), { price: p, ts: nowTick * TICK_MS });
    }
  } catch (e) { /* ignore */ }
}

function startTickLoop() {
  advanceTick();
  setInterval(advanceTick, TICK_MS);
}

// ===========================================================
// TICKS (for chart)
// ===========================================================
function subscribeTicks() {
  const q = query(ticksCol, orderBy("ts", "asc"), limitToLast(MAX_TICK_HISTORY));
  onSnapshot(q, (snap) => {
    ticks = snap.docs.map(d => d.data());
    drawChart();
  });
}

// ===========================================================
// TRADES (feed, markers, traders)
// ===========================================================
function subscribeTrades() {
  const q = query(tradesCol, orderBy("timestamp", "desc"), limit(500));
  onSnapshot(q, (snap) => {
    trades = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .map(t => ({ ...t, ts: t.timestamp && t.timestamp.toMillis ? t.timestamp.toMillis() : (t.tsFallback || Date.now()) }))
      .filter(t => t.ts);
    buildTraderMap();
    renderFeed();
    renderTraders();
    renderTopStats();
    drawChart();
  });
}

function buildTraderMap() {
  traderMap = new Map();
  for (const t of trades) {
    if (!traderMap.has(t.uid)) {
      traderMap.set(t.uid, { username: t.username, avatarUrl: t.avatarUrl, buys: 0, sells: 0, volume: 0, lastTs: t.ts });
    }
    const rec = traderMap.get(t.uid);
    if (t.type === "buy") rec.buys++; else rec.sells++;
    rec.volume += t.usdAmount || 0;
    if (t.ts > rec.lastTs) rec.lastTs = t.ts;
  }
}

// ===========================================================
// RENDER: top stats / price / vial
// ===========================================================
function fmtPrice(p) {
  if (p >= 1) return "$" + p.toFixed(4);
  if (p >= 0.01) return "$" + p.toFixed(6);
  return "$" + p.toFixed(8);
}
function fmtUsd(n) {
  return "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
}
function fmtCompact(n) {
  if (n >= 1e9) return "$" + (n / 1e9).toFixed(2) + "B";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(0);
}

function renderTopStats() {
  const price = marketState.price || STARTING_PRICE;
  const open = marketState.priceOpen24h || STARTING_PRICE;
  const changePct = open ? ((price - open) / open) * 100 : 0;

  el("statPrice").textContent = fmtPrice(price);
  el("livePrice").textContent = fmtPrice(price);
  el("statMcap").textContent = fmtCompact(marketState.marketCap || price * TOTAL_SUPPLY);
  el("statTraders").textContent = traderMap.size;

  const dEl = el("statChange");
  const lEl = el("liveDelta");
  const sign = changePct >= 0 ? "+" : "";
  const txt = `${sign}${changePct.toFixed(2)}%`;
  dEl.textContent = txt;
  lEl.textContent = txt;
  dEl.style.color = changePct >= 0 ? "var(--toxic)" : "var(--venom)";
  lEl.className = "price-delta " + (changePct >= 0 ? "up" : "down");

  if (trades.length) {
    const t = trades[0];
    const verb = t.type === "buy" ? "bought" : "sold";
    el("lastTradeNote").textContent = `${t.username} just ${verb} ${fmtUsd(t.usdAmount)} of $PLTY`;
  }
}

function renderVial() {
  // volatility = stdev of pct changes over last ~20 ticks
  const recent = ticks.slice(-20);
  let vol = 0;
  if (recent.length > 2) {
    const changes = [];
    for (let i = 1; i < recent.length; i++) {
      changes.push(Math.abs((recent[i].price - recent[i - 1].price) / recent[i - 1].price));
    }
    vol = changes.reduce((a, b) => a + b, 0) / changes.length;
  }
  const pct = Math.min(100, vol * 100 * 18); // scale for visibility
  el("venomFill").style.height = Math.max(8, pct) + "%";
}

// ===========================================================
// RENDER: profile / wallet
// ===========================================================
function renderProfile() {
  if (!currentUser) return;
  el("profileAvatar").src = currentUser.avatarUrl || DEFAULT_AVATAR;
  el("profileName").textContent = currentUser.username || "anon";
}
function renderWallet() {
  if (!currentUser) return;
  const price = marketState.price || STARTING_PRICE;
  const coinsVal = (currentUser.holdings || 0) * price;
  el("walletCash").textContent = fmtUsd(currentUser.balance || 0);
  el("walletCoins").textContent = (currentUser.holdings || 0).toFixed(8);
  el("walletCoinsValue").textContent = fmtUsd(coinsVal);
  el("walletTotal").textContent = fmtUsd((currentUser.balance || 0) + coinsVal);
}

// ===========================================================
// RENDER: feed
// ===========================================================
const avatarImgCache = new Map();
function getAvatarImg(url) {
  const key = url || DEFAULT_AVATAR;
  if (avatarImgCache.has(key)) return avatarImgCache.get(key);
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = key;
  img.onerror = () => { img.src = DEFAULT_AVATAR; };
  avatarImgCache.set(key, img);
  return img;
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  return Math.floor(s / 3600) + "h ago";
}

function renderFeed() {
  const list = el("feedList");
  if (!trades.length) {
    list.innerHTML = `<li class="feed-empty">No trades yet. Be the first to make a splash.</li>`;
    return;
  }
  list.innerHTML = trades.slice(0, 40).map(t => {
    const verbClass = t.type === "buy" ? "verb-buy" : "verb-sell";
    const verb = t.type === "buy" ? "bought" : "sold";
    return `
      <li class="feed-item">
        <img src="${(t.avatarUrl || DEFAULT_AVATAR)}" onerror="this.src='${DEFAULT_AVATAR}'" alt="" />
        <div class="feed-main">
          <span class="feed-line1"><strong>${escapeHtml(t.username)}</strong> <span class="${verbClass}">${verb}</span> ${fmtUsd(t.usdAmount)}</span>
          <span class="feed-line2">${fmtPrice(t.price)} · ${timeAgo(t.ts)}</span>
        </div>
        <span class="feed-badge ${t.type}">${t.type === "buy" ? "▲ BUY" : "▼ SELL"}</span>
      </li>`;
  }).join("");
}

function renderTraders() {
  const list = el("traderList");
  const arr = [...traderMap.entries()].sort((a, b) => b[1].volume - a[1].volume);
  if (!arr.length) {
    list.innerHTML = `<li class="trader-empty">No traders on the board yet.</li>`;
    return;
  }
  list.innerHTML = arr.map(([uid, r]) => `
    <li class="trader-item">
      <img src="${r.avatarUrl || DEFAULT_AVATAR}" onerror="this.src='${DEFAULT_AVATAR}'" alt="" />
      <div class="trader-main">
        <span class="trader-name">${escapeHtml(r.username)}</span>
        <span class="trader-sub">${fmtUsd(r.volume)} volume · ${timeAgo(r.lastTs)}</span>
      </div>
      <div class="trader-counts">
        <span class="trader-count buy">${r.buys}B</span>
        <span class="trader-count sell">${r.sells}S</span>
      </div>
    </li>`).join("");
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// ===========================================================
// PANEL TABS
// ===========================================================
document.querySelectorAll(".panel-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".panel-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const target = btn.dataset.panel;
    ["feed", "traders", "wallet"].forEach(p => {
      el("panel" + p[0].toUpperCase() + p.slice(1)).classList.toggle("hidden", p !== target);
    });
  });
});

// ===========================================================
// TIMEFRAMES
// ===========================================================
document.querySelectorAll(".tf-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tf-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    activeTF = btn.dataset.tf;
    drawChart();
  });
});

const TF_CONFIG = {
  live: { bucketMs: TICK_MS, maxCandles: 90 },
  "1m": { bucketMs: 60 * 1000, maxCandles: 80 },
  "5m": { bucketMs: 5 * 60 * 1000, maxCandles: 80 },
  "10m": { bucketMs: 10 * 60 * 1000, maxCandles: 80 },
  "1h": { bucketMs: 60 * 60 * 1000, maxCandles: 80 },
  all: { bucketMs: 30 * 60 * 1000, maxCandles: 200 }
};

function buildCandles(bucketMs, maxCandles) {
  if (!ticks.length) return [];
  const map = new Map();
  for (const t of ticks) {
    const bucket = Math.floor(t.ts / bucketMs) * bucketMs;
    if (!map.has(bucket)) {
      map.set(bucket, { ts: bucket, open: t.price, high: t.price, low: t.price, close: t.price });
    }
    const c = map.get(bucket);
    c.high = Math.max(c.high, t.price);
    c.low = Math.min(c.low, t.price);
    c.close = t.price;
  }
  const arr = [...map.values()].sort((a, b) => a.ts - b.ts);
  return arr.slice(-maxCandles);
}

// ===========================================================
// CANVAS CHART
// ===========================================================
const canvas = el("chartCanvas");
const ctx = canvas.getContext("2d");
let chartLayout = null; // cached for hit-testing / markers

function resizeCanvas() {
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const w = wrap.clientWidth, h = wrap.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawChart();
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function drawChart() {
  const cfg = TF_CONFIG[activeTF];
  const candles = buildCandles(cfg.bucketMs, cfg.maxCandles);
  const w = canvas.clientWidth, h = canvas.clientHeight;
  ctx.clearRect(0, 0, w, h);

  el("chartEmpty").classList.toggle("hidden", candles.length > 0);
  if (!candles.length) { chartLayout = null; return; }

  const padL = 8, padR = 64, padT = 20, padB = 26;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  let min = Infinity, max = -Infinity;
  for (const c of candles) { min = Math.min(min, c.low); max = Math.max(max, c.high); }
  if (min === max) { min *= 0.98; max *= 1.02; }
  const pad = (max - min) * 0.08;
  min -= pad; max += pad;

  const xStep = plotW / candles.length;
  const yFor = (p) => padT + plotH - ((p - min) / (max - min)) * plotH;
  const xFor = (i) => padL + i * xStep + xStep / 2;

  // grid
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  ctx.font = "10px 'JetBrains Mono', monospace";
  ctx.fillStyle = cssVar("--text-faint") || "#5a6b60";
  const gridLines = 4;
  for (let i = 0; i <= gridLines; i++) {
    const y = padT + (plotH / gridLines) * i;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR + 6, y); ctx.stroke();
    const val = max - ((max - min) / gridLines) * i;
    ctx.fillText(fmtPrice(val), w - padR + 10, y + 3);
  }

  // candles
  const bodyW = Math.max(2, xStep * 0.6);
  candles.forEach((c, i) => {
    const x = xFor(i);
    const up = c.close >= c.open;
    const color = up ? (cssVar("--toxic") || "#7cff6b") : (cssVar("--venom") || "#ff3d6e");
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.moveTo(x, yFor(c.high));
    ctx.lineTo(x, yFor(c.low));
    ctx.stroke();
    const yOpen = yFor(c.open), yClose = yFor(c.close);
    const top = Math.min(yOpen, yClose);
    const bh = Math.max(1.5, Math.abs(yClose - yOpen));
    ctx.fillRect(x - bodyW / 2, top, bodyW, bh);
  });

  // live pulse dot on last candle
  const last = candles[candles.length - 1];
  const lx = xFor(candles.length - 1);
  const ly = yFor(last.close);
  ctx.fillStyle = cssVar("--bill") || "#ffc94d";
  ctx.beginPath(); ctx.arc(lx, ly, 3.5, 0, Math.PI * 2); ctx.fill();

  // x-axis time labels (first, middle, last)
  ctx.fillStyle = cssVar("--text-faint") || "#5a6b60";
  ctx.font = "10px 'JetBrains Mono', monospace";
  [0, Math.floor(candles.length / 2), candles.length - 1].forEach(i => {
    if (i < 0 || i >= candles.length) return;
    const d = new Date(candles[i].ts);
    const label = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const tx = Math.min(Math.max(xFor(i) - 18, padL), w - padR - 40);
    ctx.fillText(label, tx, h - 8);
  });

  chartLayout = { candles, xFor, yFor, min, max, padL, padR, padT, padB, plotW, plotH, w, h, bucketMs: cfg.bucketMs };

  drawTradeMarkers();
  drawHoverTooltip();
}

function drawTradeMarkers() {
  if (!chartLayout) return;
  const { candles, xFor, yFor, bucketMs } = chartLayout;
  if (!candles.length) return;
  const firstTs = candles[0].ts, lastTs = candles[candles.length - 1].ts + bucketMs;
  const visible = trades.filter(t => t.ts >= firstTs && t.ts < lastTs).slice(0, 120);

  for (const t of visible) {
    const idx = Math.min(candles.length - 1, Math.max(0, Math.floor((t.ts - firstTs) / bucketMs)));
    const x = xFor(idx);
    const y = yFor(t.price);
    const color = t.type === "buy" ? (cssVar("--toxic") || "#7cff6b") : (cssVar("--venom") || "#ff3d6e");

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.fillStyle = "rgba(11,14,12,0.9)";
    ctx.fill();
    ctx.stroke();

    const img = getAvatarImg(t.avatarUrl);
    if (img.complete && img.naturalWidth) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, x - 7, y - 7, 14, 14);
      ctx.restore();
    }
    ctx.restore();
  }
  chartLayout.visibleTrades = visible.map(t => ({ ...t, _x: xFor(Math.min(candles.length - 1, Math.max(0, Math.floor((t.ts - firstTs) / bucketMs)))), _y: yFor(t.price) }));
}

function drawHoverTooltip() {
  const tip = el("chartTooltip");
  if (!hoverPoint || !chartLayout) { tip.classList.add("hidden"); return; }

  // check trade marker proximity first
  const trade = (chartLayout.visibleTrades || []).find(t => Math.hypot(t._x - hoverPoint.x, t._y - hoverPoint.y) < 10);
  if (trade) {
    tip.classList.remove("hidden");
    tip.style.left = Math.min(hoverPoint.x + 14, chartLayout.w - 170) + "px";
    tip.style.top = Math.max(hoverPoint.y - 50, 4) + "px";
    tip.innerHTML = `<strong>${escapeHtml(trade.username)}</strong><br/>${trade.type === "buy" ? "Bought" : "Sold"} ${fmtUsd(trade.usdAmount)}<br/>@ ${fmtPrice(trade.price)}`;
    return;
  }

  const { candles, xFor } = chartLayout;
  let closest = null, closestDist = Infinity;
  candles.forEach((c, i) => {
    const d = Math.abs(xFor(i) - hoverPoint.x);
    if (d < closestDist) { closestDist = d; closest = c; }
  });
  if (!closest) { tip.classList.add("hidden"); return; }
  tip.classList.remove("hidden");
  tip.style.left = Math.min(hoverPoint.x + 14, chartLayout.w - 150) + "px";
  tip.style.top = Math.max(hoverPoint.y - 60, 4) + "px";
  const d = new Date(closest.ts);
  tip.innerHTML = `${d.toLocaleTimeString()}<br/>O ${fmtPrice(closest.open)} H ${fmtPrice(closest.high)}<br/>L ${fmtPrice(closest.low)} C ${fmtPrice(closest.close)}`;
}

canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  hoverPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  drawHoverTooltip();
});
canvas.addEventListener("mouseleave", () => { hoverPoint = null; el("chartTooltip").classList.add("hidden"); });

// redraw loop for smooth live updates (avatars loading, pulse) — lightweight
setInterval(() => { if (booted) drawChart(); }, 1500);

// ===========================================================
// TRADE SHEET (Apple-Pay style)
// ===========================================================
function openSheet(mode) {
  sheetMode = mode;
  sheetAmount = "";
  el("sheetError").textContent = "";
  el("sheetTitle").textContent = mode === "buy" ? "Buy $PLTY" : "Sell $PLTY";
  el("slideLabel").textContent = mode === "buy" ? "Slide to Buy" : "Slide to Sell";
  el("slideConfirm").querySelector(".slide-track").className = "slide-track" + (mode === "sell" ? " selling" : "");
  resetSlider();
  renderSheetAmount();
  renderSheetConvert();
  el("sheetBackdrop").classList.remove("hidden");
}
function closeSheet() {
  el("sheetBackdrop").classList.add("hidden");
}
el("openBuy").addEventListener("click", () => openSheet("buy"));
el("openSell").addEventListener("click", () => openSheet("sell"));
el("sheetClose").addEventListener("click", closeSheet);
el("sheetBackdrop").addEventListener("click", (e) => { if (e.target === el("sheetBackdrop")) closeSheet(); });

function renderSheetAmount() {
  el("sheetAmountValue").textContent = sheetAmount || "0";
}
function renderSheetConvert() {
  const price = marketState.price || STARTING_PRICE;
  const amt = parseFloat(sheetAmount || "0") || 0;
  if (sheetMode === "buy") {
    el("sheetConvert").textContent = `≈ ${(amt / price).toFixed(8)} PLTY`;
  } else {
    const coinAmt = amt; // in sell mode, keypad value represents USD equivalent too, converted below at confirm
    el("sheetConvert").textContent = `≈ ${(amt / price).toFixed(8)} PLTY worth`;
  }
}

el("keypad").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const k = btn.dataset.k;
  if (k === "back") { sheetAmount = sheetAmount.slice(0, -1); }
  else if (k === ".") { if (!sheetAmount.includes(".")) sheetAmount += "."; }
  else {
    if (sheetAmount.replace(".", "").length >= 9) return;
    sheetAmount += k;
  }
  renderSheetAmount();
  renderSheetConvert();
});

el("sheetPresets").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  if (btn.dataset.amt) {
    sheetAmount = btn.dataset.amt;
  } else if (btn.dataset.max) {
    const price = marketState.price || STARTING_PRICE;
    if (sheetMode === "buy") {
      sheetAmount = String(Math.floor((currentUser?.balance || 0) * 100) / 100);
    } else {
      sheetAmount = String(Math.floor((currentUser?.holdings || 0) * price * 100) / 100);
    }
  }
  renderSheetAmount();
  renderSheetConvert();
});

// ---- slide to confirm ----
const slideThumb = el("slideThumb");
const slideTrackWrap = el("slideConfirm");
let dragging = false, dragStartX = 0, thumbStartX = 0;

function resetSlider() {
  slideThumb.style.transform = "translateX(0px)";
  slideTrackWrap.querySelector(".slide-track").classList.remove("confirmed");
}

function getTrackBounds() {
  const track = slideTrackWrap.querySelector(".slide-track");
  const maxX = track.clientWidth - slideThumb.clientWidth - 8;
  return { maxX };
}

function onPointerDown(e) {
  dragging = true;
  dragStartX = (e.touches ? e.touches[0].clientX : e.clientX);
  const t = slideThumb.style.transform.match(/-?\d+/);
  thumbStartX = t ? parseFloat(t[0]) : 0;
  slideThumb.style.cursor = "grabbing";
}
function onPointerMove(e) {
  if (!dragging) return;
  const clientX = (e.touches ? e.touches[0].clientX : e.clientX);
  const { maxX } = getTrackBounds();
  let dx = thumbStartX + (clientX - dragStartX);
  dx = Math.max(0, Math.min(maxX, dx));
  slideThumb.style.transform = `translateX(${dx}px)`;
  if (dx >= maxX - 2) {
    dragging = false;
    confirmTrade();
  }
}
function onPointerUp() {
  if (!dragging) return;
  dragging = false;
  const { maxX } = getTrackBounds();
  const t = slideThumb.style.transform.match(/-?\d+/);
  const dx = t ? parseFloat(t[0]) : 0;
  if (dx < maxX - 2) resetSlider();
}
slideThumb.addEventListener("mousedown", onPointerDown);
slideThumb.addEventListener("touchstart", onPointerDown, { passive: true });
window.addEventListener("mousemove", onPointerMove);
window.addEventListener("touchmove", onPointerMove, { passive: true });
window.addEventListener("mouseup", onPointerUp);
window.addEventListener("touchend", onPointerUp);

async function confirmTrade() {
  const amt = parseFloat(sheetAmount || "0") || 0;
  const errEl = el("sheetError");
  errEl.textContent = "";
  if (amt <= 0) { errEl.textContent = "Enter an amount first."; resetSlider(); return; }

  slideTrackWrap.querySelector(".slide-track").classList.add("confirmed");

  try {
    await executeTrade(sheetMode, amt);
    toast(`${sheetMode === "buy" ? "Bought" : "Sold"} ${fmtUsd(amt)} of $PLTY`, false);
    setTimeout(closeSheet, 450);
  } catch (e) {
    errEl.textContent = e.message || "Trade failed.";
    resetSlider();
  }
}

async function executeTrade(mode, usdAmount) {
  const uref = doc(usersCol, currentUser.uid);
  const IMPACT_FACTOR = 2.2;

  await runTransaction(db, async (tx) => {
    const [marketSnap, userSnap] = await Promise.all([tx.get(marketRef), tx.get(uref)]);
    if (!marketSnap.exists() || !userSnap.exists()) throw new Error("Not ready, try again.");
    let price = marketSnap.data().price;
    const marketCapNow = price * TOTAL_SUPPLY;
    const u = userSnap.data();
    let balance = u.balance || 0;
    let holdings = u.holdings || 0;

    if (mode === "buy") {
      if (usdAmount > balance + 1e-9) throw new Error("Not enough cash.");
      const coinAmount = usdAmount / price;
      const impact = Math.min(0.25, (usdAmount / marketCapNow) * IMPACT_FACTOR);
      price = price * (1 + impact);
      balance -= usdAmount;
      holdings += coinAmount;
      tx.update(marketRef, { price, marketCap: price * TOTAL_SUPPLY });
      tx.update(uref, { balance, holdings });
      const tradeDoc = doc(tradesCol);
      tx.set(tradeDoc, {
        uid: currentUser.uid, username: currentUser.username, avatarUrl: currentUser.avatarUrl || DEFAULT_AVATAR,
        type: "buy", usdAmount, coinAmount, price, timestamp: serverTimestamp()
      });
    } else {
      const priceNow = marketSnap.data().price;
      const coinAmount = usdAmount / priceNow;
      if (coinAmount > holdings + 1e-9) throw new Error("Not enough $PLTY held.");
      const usdReceived = coinAmount * priceNow;
      const impact = Math.min(0.25, (usdReceived / marketCapNow) * IMPACT_FACTOR);
      price = priceNow * (1 - impact);
      balance += usdReceived;
      holdings -= coinAmount;
      tx.update(marketRef, { price, marketCap: price * TOTAL_SUPPLY });
      tx.update(uref, { balance, holdings });
      const tradeDoc = doc(tradesCol);
      tx.set(tradeDoc, {
        uid: currentUser.uid, username: currentUser.username, avatarUrl: currentUser.avatarUrl || DEFAULT_AVATAR,
        type: "sell", usdAmount: usdReceived, coinAmount, price, timestamp: serverTimestamp()
      });
    }
  });
}

// ===========================================================
// TOASTS
// ===========================================================
function toast(msg, isError) {
  const stack = el("toastStack");
  const t = document.createElement("div");
  t.className = "toast" + (isError ? " error" : "");
  t.textContent = msg;
  stack.appendChild(t);
  setTimeout(() => t.remove(), 3800);
}

// ===========================================================
// PROFILE / LOGOUT
// ===========================================================
el("profileChip").addEventListener("click", () => {
  document.querySelectorAll(".panel-tab").forEach(b => b.classList.remove("active"));
  document.querySelector('[data-panel="wallet"]').classList.add("active");
  ["feed", "traders", "wallet"].forEach(p => {
    el("panel" + p[0].toUpperCase() + p.slice(1)).classList.toggle("hidden", p !== "wallet");
  });
});

el("logoutBtn").addEventListener("click", async () => {
  await auth.signOut();
  location.reload();
});
