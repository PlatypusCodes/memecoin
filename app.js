// ===========================================================
// PLATYPUS ($PLTY) — single-coin trading terminal  v3
// Features: leaderboard, trader profiles, calling-it posts,
//   referral links, stop-loss/take-profit, portfolio sparkline,
//   P&L display, price alerts, avatar markers on all-time chart,
//   full mobile support
// ===========================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged,
  createUserWithEmailAndPassword, signInWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.13.2/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, updateDoc, onSnapshot,
  collection, query, orderBy, limit,
  runTransaction, serverTimestamp, getDocs, where
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
const REFERRAL_BONUS = 500;
const TICK_MS = 3000;
const GLOBAL_SEED = 90210;
const DEFAULT_AVATAR = "https://avatars.githubusercontent.com/u/298894342?s=60&v=4";
const MAX_TICK_HISTORY = 2000;

const marketRef = doc(db, "market", "state");
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
  if (r3 < 0.05) {
    const magnitude = 0.12 + r2 * 0.28;
    const dir = r4 < 0.5 ? -1 : 1;
    changePct = dir * magnitude;
  } else {
    const drift = (r1 - 0.5) * 0.06;
    const noise = (r2 - 0.5) * 0.14;
    changePct = drift + noise;
  }
  const ratio = price / STARTING_PRICE;
  if (ratio < 0.15) {
    changePct += 0.06 + (1 - ratio) * 0.08;
  } else if (ratio < 0.4) {
    changePct += 0.025;
  } else if (ratio > 8) {
    changePct -= 0.02;
  }
  return Math.max(price * (1 + changePct), STARTING_PRICE * 0.05);
}

// ---------- state ----------
let currentUser = null;
let marketState = { price: STARTING_PRICE, marketCap: STARTING_PRICE * TOTAL_SUPPLY, lastTickIndex: 0, priceOpen24h: STARTING_PRICE };
let ticks = [];
let trades = [];
let traderMap = new Map();
let activeTF = "live";
let chartType = localStorage.getItem("plty_chart_type") || "candles";
let hoverPoint = null;
let sheetMode = "buy";
let sheetAmount = "";
let sheetSellAll = false;
let lbSort = "pnl";

// Portfolio history for sparkline (array of {ts, value})
let portfolioHistory = [];
let lastPortfolioValue = null;

// Triggers / alerts state
let stopLossPrice = null;
let takeProfitPrice = null;
let alertAbovePrice = null;
let alertBelowPrice = null;
let alertAboveFired = false;
let alertBelowFired = false;
let triggersExecuting = false;

// Firestore quota fallback — when reads are exhausted, sell is cached locally
let _firestoreQuotaExceeded = false;
let _lastTradeWasLocal = false; // set true when sell was applied locally due to quota
let _pendingSellQueue = JSON.parse(localStorage.getItem("plty_pending_sells") || "[]");

function _savePendingSells() {
  try { localStorage.setItem("plty_pending_sells", JSON.stringify(_pendingSellQueue)); } catch (_) {}
}

// Try to flush pending sells from the queue whenever Firestore might be available again.
// We write directly (no transaction read) because the local sell already updated currentUser —
// Firestore still has the pre-sell holdings and a transaction read would see those stale values.
async function _flushPendingSells() {
  if (!_pendingSellQueue.length || !currentUser) return;
  const item = _pendingSellQueue[0];
  try {
    const uref = doc(usersCol, currentUser.uid);
    const price = marketState.price || STARTING_PRICE;
    const usdReceived = item.coinAmount ? item.coinAmount * price : item.usdAmount;
    // Write the locally-computed end state directly — no reads needed
    await updateDoc(uref, {
      balance:  currentUser.balance,
      holdings: currentUser.holdings,
      costBasis: currentUser.costBasis || 0
    });
    // Log the trade to the trades collection (setDoc/doc already imported at top of file)
    const tradeRef = doc(tradesCol);
    await setDoc(tradeRef, {
      uid: currentUser.uid, username: currentUser.username, avatarUrl: currentUser.avatarUrl || DEFAULT_AVATAR,
      type: "sell", usdAmount: usdReceived, coinAmount: item.coinAmount || 0, price,
      callingIt: item.callingIt || "", timestamp: serverTimestamp()
    });
    _pendingSellQueue.shift();
    _savePendingSells();
    if (_pendingSellQueue.length) setTimeout(_flushPendingSells, 3000);
    else { _firestoreQuotaExceeded = false; toast("Pending sell synced to server ✓", false); }
  } catch (_) {
    // Still quota-exceeded — will retry on next interval
  }
}
setInterval(_flushPendingSells, 30000);

// Quick trade buttons config
const DEFAULT_QUICK_BUYS  = [25, 100, 500];    // USD amounts
const DEFAULT_QUICK_SELLS = [25, 50, 100];      // % of holdings
let quickBuys  = [...DEFAULT_QUICK_BUYS];
let quickSells = [...DEFAULT_QUICK_SELLS];

// ===========================================================
// AUTH / ONBOARDING
// ===========================================================
const el = (id) => document.getElementById(id);

function showApp() {
  el("authGate").classList.add("hidden");
  el("app").classList.remove("hidden");
}
function showAuthTabs(mode) {
  el("authLoading").classList.add("hidden");
  el("authTabs").classList.remove("hidden");
  const defaultMode = mode || (localStorage.getItem("plty_has_account") ? "login" : "signup");
  setAuthMode(defaultMode);
}
function setAuthMode(mode) {
  document.querySelectorAll(".auth-tab").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  el("onboardForm").classList.toggle("hidden", mode !== "signup");
  el("loginForm").classList.toggle("hidden", mode !== "login");
}
document.querySelectorAll(".auth-tab").forEach(btn => {
  btn.addEventListener("click", () => setAuthMode(btn.dataset.mode));
});

// Pre-fill referral code from URL ?ref=username
(function applyRefFromUrl() {
  const p = new URLSearchParams(location.search);
  const ref = p.get("ref");
  if (ref) el("refInput").value = ref;
})();

let authBusy = false;

onAuthStateChanged(auth, async (user) => {
  if (authBusy) return;
  if (!user) { showAuthTabs(); return; }
  const uref = doc(usersCol, user.uid);
  const snap = await getDoc(uref);
  if (snap.exists()) {
    currentUser = { uid: user.uid, ...snap.data() };
    subscribeUser(uref);
    boot();
  } else {
    window.__pendingUserRef = uref;
    window.__pendingEmail = user.email;
    showAuthTabs("signup");
  }
});

function authError(msg) { el("authError").textContent = msg; }
function loginError(msg) { el("loginError").textContent = msg; }
function friendlyAuthError(code) {
  const map = {
    "auth/email-already-in-use": "That email already has an account — switched you to Log in.",
    "auth/invalid-email": "That email address doesn't look right.",
    "auth/weak-password": "Password needs to be at least 6 characters.",
    "auth/password-does-not-meet-requirements": "Password doesn't meet this project's policy — try 8+ characters with a number and a symbol.",
    "auth/wrong-password": "Wrong password.",
    "auth/user-not-found": "No account found with that email.",
    "auth/invalid-credential": "Email or password is incorrect.",
    "auth/too-many-requests": "Too many attempts — wait a bit and try again.",
    "auth/operation-not-allowed": "Email/password sign-in isn't enabled on this project yet."
  };
  return map[code] || null;
}
function describeAuthErr(err) {
  const friendly = friendlyAuthError(err.code);
  if (friendly) return friendly;
  return err.code ? `${err.message} (${err.code})` : (err.message || "Something went wrong.");
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
  authError("");
  const username = el("usernameInput").value.trim().slice(0, 18);
  if (!username) { authError("Pick a username."); return; }
  const avatarUrl = el("avatarInput").value.trim() || DEFAULT_AVATAR;
  const email = el("signupEmail").value.trim();
  const password = el("signupPassword").value;
  const refCode = el("refInput").value.trim().toLowerCase();

  el("onboardSubmit").disabled = true;
  el("onboardSubmit").textContent = "Diving in…";
  authBusy = true;
  try {
    let uref = window.__pendingUserRef;
    let uid = uref ? uref.id : null;

    if (!uid) {
      const cred = await createUserWithEmailAndPassword(auth, email, password);
      uid = cred.user.uid;
      uref = doc(usersCol, uid);
    }

    let bonusBalance = STARTING_BALANCE;
    let referredBy = null;

    // Handle referral
    if (refCode && refCode !== username.toLowerCase()) {
      try {
        const refQ = query(usersCol, where("username", "==", refCode), limit(1));
        const refSnap = await getDocs(refQ);
        if (!refSnap.empty) {
          const refDoc = refSnap.docs[0];
          referredBy = refDoc.id;
          bonusBalance += REFERRAL_BONUS;
          // Give referrer their bonus too
          await updateDoc(doc(usersCol, refDoc.id), {
            balance: (refDoc.data().balance || STARTING_BALANCE) + REFERRAL_BONUS
          });
        }
      } catch (_) {}
    }

    const data = {
      username, avatarUrl,
      email: email || window.__pendingEmail || "",
      balance: bonusBalance,
      holdings: 0,
      createdAt: Date.now(),
      referredBy: referredBy || null,
      costBasis: 0  // average cost basis for P&L
    };
    await setDoc(uref, data);
    currentUser = { uid, ...data };
    subscribeUser(uref);
    authBusy = false;
    localStorage.setItem("plty_has_account", "1");
    boot();
  } catch (err) {
    if (err.code === "auth/email-already-in-use") {
      localStorage.setItem("plty_has_account", "1");
      setAuthMode("login");
      el("loginEmail").value = email;
      loginError("That email already has an account — enter your password to log in.");
    } else {
      authError(describeAuthErr(err));
    }
    el("onboardSubmit").disabled = false;
    el("onboardSubmit").textContent = "Enter the pond";
    authBusy = false;
  }
});

el("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  loginError("");
  const email = el("loginEmail").value.trim();
  const password = el("loginPassword").value;
  el("loginSubmit").disabled = true;
  el("loginSubmit").textContent = "Logging in…";
  authBusy = true;
  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const uref = doc(usersCol, cred.user.uid);
    const snap = await getDoc(uref);
    if (!snap.exists()) {
      window.__pendingUserRef = uref;
      window.__pendingEmail = email;
      authBusy = false;
      setAuthMode("signup");
      el("loginSubmit").disabled = false;
      el("loginSubmit").textContent = "Log in";
      return;
    }
    currentUser = { uid: cred.user.uid, ...snap.data() };
    subscribeUser(uref);
    authBusy = false;
    localStorage.setItem("plty_has_account", "1");
    boot();
  } catch (err) {
    loginError(describeAuthErr(err));
    el("loginSubmit").disabled = false;
    el("loginSubmit").textContent = "Log in";
    authBusy = false;
  }
});

function subscribeUser(uref) {
  onSnapshot(uref, (snap) => {
    if (!snap.exists()) return;
    const freshData = { uid: uref.id, ...snap.data() };
    // If we applied a local sell while Firestore was quota-limited,
    // ignore snapshots that would revert to the pre-sell state.
    // We detect this by comparing holdings: if the snapshot has MORE holdings
    // than what we have locally, it means Firestore hasn't flushed our sell yet.
    if (_firestoreQuotaExceeded && currentUser &&
        freshData.holdings > currentUser.holdings &&
        _pendingSellQueue.length > 0) {
      // Stale snapshot — preserve local balance/holdings, sync everything else
      freshData.holdings = currentUser.holdings;
      freshData.balance  = currentUser.balance;
      freshData.costBasis = currentUser.costBasis;
    }
    currentUser = freshData;
    // When quota clears, the snapshot arriving after a successful flush
    // is authoritative — clear the quota flag so we stop blocking snapshots.
    if (!_firestoreQuotaExceeded && _pendingSellQueue.length === 0) {
      // Normal path — no pending sells, all good
    }
    // Load triggers from Firestore (source of truth — works across devices)
    if (currentUser.stopLoss !== undefined)    stopLossPrice   = currentUser.stopLoss   || null;
    if (currentUser.takeProfit !== undefined)  takeProfitPrice = currentUser.takeProfit || null;
    // Load quick trade config from user doc
    if (Array.isArray(currentUser.quickBuys))  quickBuys  = currentUser.quickBuys;
    if (Array.isArray(currentUser.quickSells)) quickSells = currentUser.quickSells;
    renderProfile();
    renderWallet();
    renderSheetConvert();
    refreshSheetIfMaxActive();
    renderTriggerStatus();
    renderQuickTradePreview();
    renderQuickBtns();
    checkTriggers();
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
  subscribeTrades();
  startTickLoop();
  resizeCanvas();
  window.addEventListener("resize", resizeCanvas);
  loadTriggers();
  loadAlerts();
  setupReferral();
  setupTriggerUI();
  setupAlertUI();
  setupQuickTradeUI();
}

// ===========================================================
// MARKET STATE
// ===========================================================

let _marketSeeded = false;

function subscribeMarket() {
  onSnapshot(marketRef, (snap) => {
    if (!snap.exists()) {
      // Fresh project -- render defaults, tick loop will create the doc soon.
      renderTopStats();
      renderVial();
      renderWallet();
      return;
    }
    marketState = snap.data();

    // On first real snapshot: seed local price state from Firestore and
    // rebuild the client-side tick history so the chart fills in.
    // NOTE: don't gate on lastTickIndex being truthy -- it can legitimately
    // be 0 on a brand-new project, and 0 is falsy in JS.
    if (!_marketSeeded) {
      _marketSeeded     = true;
      _lastKnownTickIdx = marketState.lastTickIndex || 0;
      _lastKnownPrice   = marketState.price || STARTING_PRICE;
      rebuildLocalTicks();
    } else if (marketState.lastTickIndex > _lastKnownTickIdx) {
      // Another tab wrote a newer state -- fast-forward local cache to match.
      _lastKnownTickIdx = marketState.lastTickIndex;
      _lastKnownPrice   = marketState.price;
    }

    const safe = (fn) => { try { fn(); } catch (err) { console.error("market snapshot render error:", err); } };
    safe(renderTopStats);
    safe(renderVial);
    safe(renderWallet);
    safe(renderSheetConvert);
    safe(refreshSheetIfMaxActive);
    safe(checkTriggers);
    safe(checkAlerts);
    safe(rebuildLocalTicksIfBehind);
    safe(drawChart); // keep the chart in sync with any state another tab wrote
  });
}

// If another tab (or a fresh multi-tick catch-up) moved the tick index forward
// without this tab's local tick loop having produced those intermediate ticks,
// backfill them so the "Live" candles don't show a gap/jump.
function rebuildLocalTicksIfBehind() {
  const nowTick = Math.floor(Date.now() / TICK_MS);
  const lastTs = ticks.length ? ticks[ticks.length - 1].ts : -1;
  if (_lastKnownTickIdx * TICK_MS > lastTs) {
    rebuildLocalTicks();
  }
}

// ---------- tick engine ----------
// KEY OPTIMISATION — three changes to slash Firestore usage:
//
// 1. LEADER ELECTION: only one tab per browser writes to Firestore.
//    Others compute price locally and listen for market snapshots.
//
// 2. NO TICK COLLECTION: price history is fully deterministic
//    (same seed + tickIdx => same price), so we derive it client-side
//    instead of storing every tick. Eliminates all ticks/ writes and reads.
//
// 3. THROTTLED MARKET WRITES: the leader only writes marketRef every
//    MARKET_WRITE_EVERY ticks (~15s) instead of every 3s. Local state
//    advances every tick regardless -- no visible speed change.

const TICK_JITTER = Math.floor(Math.random() * 800);
const MARKET_WRITE_EVERY = 5; // write marketRef every N ticks (~15s at 3s/tick)

// --- Leader election via localStorage ---
const LEADER_KEY   = "plty_leader_ts";
const LEADER_TTL   = 8000; // ms -- leader must refresh within this window
const LEADER_RENEW = 4000; // ms -- how often the leader refreshes its claim

let _isLeader = false;

function tryClaimLeader() {
  const now = Date.now();
  const last = parseInt(localStorage.getItem(LEADER_KEY) || "0", 10);
  if (now - last > LEADER_TTL) {
    localStorage.setItem(LEADER_KEY, String(now));
    _isLeader = true;
  }
}
function renewLeader() {
  if (_isLeader) localStorage.setItem(LEADER_KEY, String(Date.now()));
}
setInterval(renewLeader, LEADER_RENEW);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) { _isLeader = false; }
  else { tryClaimLeader(); }
});
window.addEventListener("beforeunload", () => {
  if (_isLeader) localStorage.removeItem(LEADER_KEY);
});

// --- Local price state (all tabs keep this in sync) ---
let _lastKnownPrice   = STARTING_PRICE;
let _lastKnownTickIdx = -1; // -1 = not yet seeded; set by rebuildLocalTicks or first advanceLocalTick
let _ticksSinceWrite  = 0;

// Rebuild client-side tick array from the deterministic engine.
// Called once after the first marketRef snapshot seeds _lastKnownTickIdx.
function rebuildLocalTicks() {
  const nowTick = Math.floor(Date.now() / TICK_MS);

  // Walk back at most MAX_TICK_HISTORY ticks from the current tick.
  // We can't start from 0 -- nowTick is ~580M and the loop would freeze the browser.
  // Instead fast-forward a seed price to startIdx using a shortcut, then step normally.
  const startIdx = Math.max(0, nowTick - MAX_TICK_HISTORY + 1);

  // Fast-forward price to startIdx.
  // stepPrice is cheap per call but we can't call it 580M times either,
  // so we use the known anchor from Firestore (_lastKnownPrice at _lastKnownTickIdx)
  // and only walk the short gap between that anchor and startIdx if needed.
  let p;
  if (_lastKnownTickIdx >= startIdx) {
    // Anchor is already past startIdx -- step back isn't possible, so just
    // re-derive forward from the anchor.
    p = _lastKnownPrice;
    const newTicks = [];
    for (let i = _lastKnownTickIdx + 1; i <= nowTick; i++) {
      p = stepPrice(p, i);
      newTicks.push({ price: p, ts: i * TICK_MS });
    }
    // Prepend what we have in ticks already up to anchor
    ticks = [...ticks.slice(-(MAX_TICK_HISTORY - newTicks.length)), ...newTicks];
    return;
  } else {
    // Walk forward from anchor to startIdx, then collect from startIdx to nowTick.
    p = _lastKnownPrice;
    for (let i = _lastKnownTickIdx + 1; i < startIdx; i++) {
      p = stepPrice(p, i);
    }
  }

  const newTicks = [];
  for (let i = startIdx; i <= nowTick; i++) {
    p = stepPrice(p, i);
    newTicks.push({ price: p, ts: i * TICK_MS });
  }
  ticks = newTicks;
}

function advanceLocalTick() {
  const nowTick = Math.floor(Date.now() / TICK_MS);
  // If not yet seeded by Firestore snapshot, seed from wall clock now so ticks flow immediately.
  if (_lastKnownTickIdx < 0) {
    _lastKnownTickIdx = nowTick - 1; // will add exactly 1 tick below
    _lastKnownPrice = marketState.price || STARTING_PRICE;
  }
  const lastIdx = _lastKnownTickIdx;
  if (lastIdx >= nowTick) return;

  const steps = Math.min(nowTick - lastIdx, 5);
  let price = _lastKnownPrice;
  for (let i = 1; i <= steps; i++) {
    const idx = lastIdx + i;
    price = stepPrice(price, idx);
    ticks.push({ price, ts: idx * TICK_MS });
  }
  if (ticks.length > MAX_TICK_HISTORY) ticks = ticks.slice(-MAX_TICK_HISTORY);

  _lastKnownPrice   = price;
  _lastKnownTickIdx = lastIdx + steps;

  marketState.price         = price;
  marketState.marketCap     = price * TOTAL_SUPPLY;
  marketState.lastTickIndex = _lastKnownTickIdx;

  // Each render step below is isolated so a failure in one (e.g. a trigger/alert
  // check throwing on unexpected state) can never prevent the chart from
  // redrawing -- previously an uncaught error here would silently stop the
  // rest of the tick's synchronous work, freezing the "Live" chart while
  // stats that render earlier in the sequence kept updating.
  const safe = (fn) => { try { fn(); } catch (err) { console.error("tick render error:", err); } };
  safe(renderTopStats);
  safe(renderVial);
  safe(renderWallet);
  safe(renderSheetConvert);
  safe(refreshSheetIfMaxActive);
  safe(checkTriggers);
  safe(checkAlerts);
  safe(drawChart);
}

async function maybeWriteMarket() {
  if (!_isLeader) return;
  _ticksSinceWrite++;
  if (_ticksSinceWrite < MARKET_WRITE_EVERY) return;
  _ticksSinceWrite = 0;

  const price   = _lastKnownPrice;
  const tickIdx = _lastKnownTickIdx;
  try {
    await updateDoc(marketRef, { price, marketCap: price * TOTAL_SUPPLY, lastTickIndex: tickIdx });
  } catch (_) {
    try {
      await setDoc(marketRef, {
        price, marketCap: price * TOTAL_SUPPLY,
        lastTickIndex: tickIdx, priceOpen24h: STARTING_PRICE, createdAt: Date.now()
      });
    } catch (_) {}
  }
}

function advanceTick() {
  // Always advance local ticks and redraw the chart — even when the tab is hidden.
  // This keeps ticks[] current so the chart is already up-to-date when the user
  // returns, instead of appearing frozen. Only the Firestore write is gated on
  // visibility (no point writing when no tab is actively watching).
  advanceLocalTick();
  if (!document.hidden) maybeWriteMarket();
}

function startTickLoop() {
  tryClaimLeader();
  setTimeout(() => {
    advanceTick();
    setInterval(advanceTick, TICK_MS);
  }, TICK_JITTER);
}

// TICKS: no longer a Firestore collection -- derived client-side
// from the deterministic price engine. See rebuildLocalTicks() and advanceLocalTick().

// ===========================================================
// TRADES
// ===========================================================
function subscribeTrades() {
  const q = query(tradesCol, orderBy("timestamp", "desc"), limit(500));
  onSnapshot(q, (snap) => {
    trades = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .map(t => ({ ...t, ts: t.timestamp && t.timestamp.toMillis ? t.timestamp.toMillis() : (t.tsFallback || Date.now()) }))
      .filter(t => t.ts);
    buildTraderMap();
    renderFeed();
    renderLeaderboard();
    renderTopStats();
    drawChart();
  });
}

function buildTraderMap() {
  traderMap = new Map();
  for (const t of trades) {
    if (!traderMap.has(t.uid)) {
      traderMap.set(t.uid, {
        username: t.username, avatarUrl: t.avatarUrl,
        buys: 0, sells: 0, volume: 0, lastTs: t.ts
      });
    }
    const rec = traderMap.get(t.uid);
    if (t.type === "buy") rec.buys++; else rec.sells++;
    rec.volume += t.usdAmount || 0;
    if (t.ts > rec.lastTs) rec.lastTs = t.ts;
  }
}

// ===========================================================
// FORMAT HELPERS
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

// ===========================================================
// RENDER: top stats
// ===========================================================
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
  const recent = ticks.slice(-20);
  let vol = 0;
  if (recent.length > 2) {
    const changes = [];
    for (let i = 1; i < recent.length; i++) {
      changes.push(Math.abs((recent[i].price - recent[i - 1].price) / recent[i - 1].price));
    }
    vol = changes.reduce((a, b) => a + b, 0) / changes.length;
  }
  const pct = Math.min(100, vol * 100 * 18);
  el("venomFill").style.height = Math.max(8, pct) + "%";
}

// ===========================================================
// RENDER: profile / wallet / sparkline / P&L
// ===========================================================
function renderProfile() {
  if (!currentUser) return;
  el("profileAvatar").src = currentUser.avatarUrl || DEFAULT_AVATAR;
  el("profileName").textContent = currentUser.username || "anon";
}

function renderWallet() {
  if (!currentUser) return;
  const price = marketState.price || STARTING_PRICE;
  const holdings = currentUser.holdings || 0;
  const balance = currentUser.balance || 0;
  const coinsVal = holdings * price;
  const total = balance + coinsVal;

  el("walletCash").textContent = fmtUsd(balance);
  el("walletCoins").textContent = holdings.toFixed(8);
  el("walletCoinsValue").textContent = fmtUsd(coinsVal);
  el("walletTotal").textContent = fmtUsd(total);

  // P&L: compare total portfolio to starting balance
  const startVal = STARTING_BALANCE + (currentUser.referredBy ? REFERRAL_BONUS : 0)
    + (currentUser.referralBonuses || 0);
  const pnl = total - startVal;
  const pnlPct = startVal > 0 ? (pnl / startVal) * 100 : 0;
  const pnlSign = pnl >= 0 ? "+" : "";
  const pnlEl = el("walletPnl");
  pnlEl.textContent = `${pnlSign}${fmtUsd(Math.abs(pnl))} (${pnlSign}${pnlPct.toFixed(2)}%)`;
  pnlEl.className = "wallet-pnl " + (pnl >= 0 ? "up" : "down");

  // Unrealised P&L on current holdings
  const costBasis = currentUser.costBasis || 0;
  if (holdings > 0 && costBasis > 0) {
    const avgCost = costBasis / holdings;
    const unrealisedUsd = (price - avgCost) * holdings;
    const unrealisedPct = avgCost > 0 ? ((price - avgCost) / avgCost) * 100 : 0;
    const uSign = unrealisedUsd >= 0 ? "+" : "";
    const uEl = el("walletUnrealised");
    uEl.textContent = `${uSign}${fmtUsd(unrealisedUsd)} (${uSign}${unrealisedPct.toFixed(2)}%)`;
    uEl.className = unrealisedUsd >= 0 ? "up" : "down";
  } else {
    el("walletUnrealised").textContent = "—";
    el("walletUnrealised").className = "";
  }

  // Track portfolio history for sparkline
  const now = Date.now();
  if (lastPortfolioValue !== total) {
    lastPortfolioValue = total;
    portfolioHistory.push({ ts: now, value: total });
    if (portfolioHistory.length > 200) portfolioHistory = portfolioHistory.slice(-200);
    drawSparkline();
  }
}

function drawSparkline() {
  const canvas = el("sparkCanvas");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.parentElement.clientWidth - 24;
  const h = 60;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const pts = portfolioHistory;
  if (pts.length < 2) {
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    ctx.font = "11px JetBrains Mono, monospace";
    ctx.fillText("Trading to build history…", 4, h / 2 + 4);
    return;
  }

  let minV = Infinity, maxV = -Infinity;
  for (const p of pts) { minV = Math.min(minV, p.value); maxV = Math.max(maxV, p.value); }
  if (minV === maxV) { minV *= 0.99; maxV *= 1.01; }
  const range = maxV - minV;

  const xFor = (i) => (i / (pts.length - 1)) * w;
  const yFor = (v) => h - ((v - minV) / range) * (h - 4) - 2;

  const up = pts[pts.length - 1].value >= pts[0].value;
  const rgb = up ? "124,255,107" : "255,61,110";
  const color = up ? "#7cff6b" : "#ff3d6e";

  // Area fill
  ctx.beginPath();
  ctx.moveTo(xFor(0), yFor(pts[0].value));
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(xFor(i), yFor(pts[i].value));
  }
  ctx.lineTo(xFor(pts.length - 1), h);
  ctx.lineTo(0, h);
  ctx.closePath();
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, `rgba(${rgb},0.2)`);
  grad.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = grad;
  ctx.fill();

  // Line
  ctx.beginPath();
  ctx.moveTo(xFor(0), yFor(pts[0].value));
  for (let i = 1; i < pts.length; i++) {
    ctx.lineTo(xFor(i), yFor(pts[i].value));
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();
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
  img.onerror = () => { img.src = DEFAULT_AVATAR; if (booted) drawChart(); };
  img.onload = () => { if (booted) drawChart(); };
  avatarImgCache.set(key, img);
  return img;
}

function timeAgo(ts) {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  return Math.floor(s / 3600) + "h ago";
}

setInterval(() => {
  if (!booted || !trades.length) return;
  document.querySelectorAll(".feed-ts").forEach(el => {
    const ts = parseInt(el.dataset.ts, 10);
    if (ts) el.textContent = timeAgo(ts);
  });
}, 1000);

function renderFeed() {
  const list = el("feedList");
  if (!trades.length) {
    list.innerHTML = `<li class="feed-empty">No trades yet. Be the first to make a splash.</li>`;
    return;
  }
  list.innerHTML = trades.slice(0, 40).map(t => {
    const verbClass = t.type === "buy" ? "verb-buy" : "verb-sell";
    const verb = t.type === "buy" ? "bought" : "sold";
    const callingIt = t.callingIt ? `<div class="feed-calling">"${escapeHtml(t.callingIt)}"</div>` : "";
    return `
      <li class="feed-item" data-uid="${t.uid}" title="View ${escapeHtml(t.username)}'s profile">
        <img src="${t.avatarUrl || DEFAULT_AVATAR}" onerror="this.src='${DEFAULT_AVATAR}'" alt="" />
        <div class="feed-main">
          <span class="feed-line1"><strong>${escapeHtml(t.username)}</strong> <span class="${verbClass}">${verb}</span> ${fmtUsd(t.usdAmount)}</span>
          <span class="feed-line2">${fmtPrice(t.price)} · <span class="feed-ts" data-ts="${t.ts}">${timeAgo(t.ts)}</span></span>
          ${callingIt}
        </div>
        <span class="feed-badge ${t.type}">${t.type === "buy" ? "▲ BUY" : "▼ SELL"}</span>
      </li>`;
  }).join("");

  // Click on feed item → open trader profile
  list.querySelectorAll(".feed-item[data-uid]").forEach(item => {
    item.addEventListener("click", () => openTraderProfile(item.dataset.uid));
  });
}

// ===========================================================
// RENDER: leaderboard
// ===========================================================
document.querySelectorAll(".lb-sort").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".lb-sort").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    lbSort = btn.dataset.sort;
    renderLeaderboard();
  });
});

function renderLeaderboard() {
  const list = el("lbList");
  if (!list) return;
  const arr = [...traderMap.entries()];
  if (!arr.length) {
    list.innerHTML = `<li class="feed-empty">No traders yet.</li>`;
    return;
  }

  const price = marketState.price || STARTING_PRICE;
  const sorted = arr.sort((a, b) => {
    if (lbSort === "volume") return b[1].volume - a[1].volume;
    // For portfolio/pnl we need on-chain data — use volume as proxy since we
    // don't store per-user portfolio snapshots in traderMap. Real implementation
    // would subscribe to all users. Using volume * rough_ratio as heuristic.
    if (lbSort === "portfolio") return b[1].volume - a[1].volume;
    if (lbSort === "pnl") return (b[1].buys - b[1].sells) - (a[1].buys - a[1].sells);
    return b[1].volume - a[1].volume;
  });

  const rankClasses = ["gold", "silver", "bronze"];
  list.innerHTML = sorted.slice(0, 50).map(([uid, r], i) => {
    const rankClass = i < 3 ? rankClasses[i] : "";
    const rankLabel = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
    // Show volume as the value
    const valueText = fmtCompact(r.volume);
    const isUp = r.buys >= r.sells;
    return `
      <li class="lb-item" data-uid="${uid}">
        <span class="lb-rank ${rankClass}">${rankLabel}</span>
        <img src="${r.avatarUrl || DEFAULT_AVATAR}" onerror="this.src='${DEFAULT_AVATAR}'" alt="" />
        <div class="lb-main">
          <span class="lb-name">${escapeHtml(r.username)}</span>
          <span class="lb-sub">${r.buys}B · ${r.sells}S · ${timeAgo(r.lastTs)}</span>
        </div>
        <span class="lb-value ${isUp ? "up" : "down"}">${valueText}</span>
      </li>`;
  }).join("");

  list.querySelectorAll(".lb-item[data-uid]").forEach(item => {
    item.addEventListener("click", () => openTraderProfile(item.dataset.uid));
  });
}

// ===========================================================
// TRADER PROFILE MODAL
// ===========================================================
el("profileModalClose").addEventListener("click", () => {
  el("profileModal").classList.add("hidden");
});
el("profileModal").addEventListener("click", (e) => {
  if (e.target === el("profileModal")) el("profileModal").classList.add("hidden");
});

function openTraderProfile(uid) {
  const rec = traderMap.get(uid);
  if (!rec) return;

  el("modalAvatar").src = rec.avatarUrl || DEFAULT_AVATAR;
  el("modalAvatar").onerror = () => { el("modalAvatar").src = DEFAULT_AVATAR; };
  el("modalUsername").textContent = rec.username;
  el("modalSince").textContent = `Last trade ${timeAgo(rec.lastTs)}`;
  el("modalVolume").textContent = fmtCompact(rec.volume);
  el("modalTrades").textContent = rec.buys + rec.sells;
  el("modalBuys").textContent = rec.buys;
  el("modalSells").textContent = rec.sells;

  // Badges
  const badges = [];
  if (rec.buys + rec.sells >= 1) badges.push({ icon: "🐣", label: "First Trade" });
  if (rec.buys + rec.sells >= 10) badges.push({ icon: "🦆", label: "Active Trader" });
  if (rec.buys + rec.sells >= 50) badges.push({ icon: "🦈", label: "Shark" });
  if (rec.volume >= 10000) badges.push({ icon: "🐋", label: "Whale" });
  if (rec.buys >= rec.sells * 3) badges.push({ icon: "💎", label: "Diamond Hands" });
  if (rec.sells >= rec.buys * 3) badges.push({ icon: "📄", label: "Paper Hands" });
  el("modalBadges").innerHTML = badges.map(b =>
    `<span class="badge"><span class="badge-icon">${b.icon}</span>${b.label}</span>`
  ).join("") || `<span style="color:var(--text-faint);font-size:11px">No badges yet</span>`;

  // Recent trades for this user
  const userTrades = trades.filter(t => t.uid === uid).slice(0, 10);
  el("modalTradesList").innerHTML = userTrades.length
    ? userTrades.map(t => `
        <li class="modal-trade-item">
          <span class="modal-trade-badge ${t.type}">${t.type === "buy" ? "▲ BUY" : "▼ SELL"}</span>
          <span class="modal-trade-amount">${fmtUsd(t.usdAmount)}</span>
          <span class="modal-trade-time">${fmtPrice(t.price)} · ${timeAgo(t.ts)}</span>
        </li>`).join("")
    : `<li style="color:var(--text-faint);font-size:12px;padding:12px 0">No recent trades in window</li>`;

  el("profileModal").classList.remove("hidden");
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// ===========================================================
// PANEL TABS
// ===========================================================
const PANELS = ["feed", "leaderboard", "wallet"];
document.querySelectorAll(".panel-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".panel-tab").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const target = btn.dataset.panel;
    PANELS.forEach(p => {
      el("panel" + p[0].toUpperCase() + p.slice(1)).classList.toggle("hidden", p !== target);
    });
    if (target === "wallet") drawSparkline();
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
document.querySelectorAll(".ct-btn").forEach(btn => {
  btn.classList.toggle("active", btn.dataset.ct === chartType);
  btn.addEventListener("click", () => {
    document.querySelectorAll(".ct-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    chartType = btn.dataset.ct;
    localStorage.setItem("plty_chart_type", chartType);
    drawChart();
  });
});

const TF_CONFIG = {
  live: { bucketMs: TICK_MS, maxCandles: 80 },
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
      map.set(bucket, { ts: bucket, open: t.price, high: t.price, low: t.price, close: t.price, _ticks: [] });
    }
    const c = map.get(bucket);
    c.high = Math.max(c.high, t.price);
    c.low = Math.min(c.low, t.price);
    c.close = t.price;
    c._ticks.push(t.price);
  }
  const arr = [...map.values()].sort((a, b) => a.ts - b.ts);

  for (let i = 0; i < arr.length; i++) {
    const c = arr[i];
    if (c.high === c.low) {
      const prevClose = i > 0 ? arr[i - 1].close : c.open;
      const nextOpen  = i < arr.length - 1 ? arr[i + 1].open : c.close;
      const ref = c.close;
      const r = seededRandom(Math.floor(c.ts / 1000), 99);
      const spread = ref * (0.008 + r * 0.022);
      c.high = ref + spread;
      c.low  = ref - spread;
      const dir = nextOpen > prevClose ? 1 : -1;
      c.open  = ref - dir * spread * 0.4;
      c.close = ref + dir * spread * 0.4;
    }
  }
  return arr.slice(-maxCandles);
}

// ===========================================================
// CANVAS CHART
// ===========================================================
const canvas = el("chartCanvas");
const ctx = canvas.getContext("2d");
let chartLayout = null;

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

  if (chartType === "line") {
    drawLineSeries(candles, xFor, yFor, padT, plotH);
  } else {
    drawCandleSeries(candles, xFor, yFor, xStep);
  }

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

function drawCandleSeries(candles, xFor, yFor, xStep) {
  const bodyW = Math.max(3, Math.min(26, xStep * 0.62));
  const toxic = cssVar("--toxic") || "#7cff6b";
  const venom = cssVar("--venom") || "#ff3d6e";
  const toxicRgb = "124,255,107";
  const venomRgb = "255,61,110";

  candles.forEach((c, i) => {
    const x = xFor(i);
    const up = c.close >= c.open;
    const rgb = up ? toxicRgb : venomRgb;
    const color = up ? toxic : venom;

    const yHigh = yFor(c.high), yLow = yFor(c.low);
    const yOpen = yFor(c.open), yClose = yFor(c.close);
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH = Math.max(4, Math.abs(yClose - yOpen));
    const bodyBottom = bodyTop + bodyH;
    const r = Math.min(3, bodyW / 3.5);

    ctx.save();
    ctx.shadowColor = `rgba(${rgb},0.35)`;
    ctx.shadowBlur = 6;
    ctx.strokeStyle = `rgba(${rgb},0.9)`;
    ctx.lineWidth = Math.max(1.5, bodyW * 0.12);
    ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(x, yHigh); ctx.lineTo(x, bodyTop); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(x, bodyBottom); ctx.lineTo(x, yLow); ctx.stroke();
    ctx.restore();

    const grad = ctx.createLinearGradient(0, bodyTop, 0, bodyBottom);
    if (up) {
      grad.addColorStop(0, `rgba(${rgb},0.98)`);
      grad.addColorStop(1, `rgba(${rgb},0.62)`);
    } else {
      grad.addColorStop(0, `rgba(${rgb},0.62)`);
      grad.addColorStop(1, `rgba(${rgb},0.98)`);
    }

    ctx.save();
    roundRectPath(ctx, x - bodyW / 2, bodyTop, bodyW, bodyH, r);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = `rgba(${rgb},1)`;
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.save();
    ctx.clip();
    const sheen = ctx.createLinearGradient(x - bodyW / 2, 0, x - bodyW / 2 + bodyW * 0.35, 0);
    sheen.addColorStop(0, "rgba(255,255,255,0.22)");
    sheen.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = sheen;
    ctx.fillRect(x - bodyW / 2, bodyTop, bodyW * 0.35, bodyH);
    ctx.restore();
    ctx.restore();
  });

  const last = candles[candles.length - 1];
  drawPulseDot(xFor(candles.length - 1), yFor(last.close));
}

function roundRectPath(c, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + rr, y);
  c.lineTo(x + w - rr, y);
  c.arcTo(x + w, y, x + w, y + rr, rr);
  c.lineTo(x + w, y + h - rr);
  c.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  c.lineTo(x + rr, y + h);
  c.arcTo(x, y + h, x, y + h - rr, rr);
  c.lineTo(x, y + rr);
  c.arcTo(x, y, x + rr, y, rr);
  c.closePath();
}

function drawLineSeries(candles, xFor, yFor, padT, plotH) {
  if (candles.length < 2) {
    const p = candles[0];
    drawPulseDot(xFor(0), yFor(p.close));
    return;
  }
  const up = candles[candles.length - 1].close >= candles[0].close;
  const color = up ? (cssVar("--toxic") || "#7cff6b") : (cssVar("--venom") || "#ff3d6e");
  const rgb   = up ? "124,255,107" : "255,61,110";

  const pts = [];
  const xW = xFor(1) - xFor(0);

  for (let i = 0; i < candles.length; i++) {
    const c  = candles[i];
    const x0 = xFor(i);

    if (c._ticks && c._ticks.length > 1) {
      const step = xW / c._ticks.length;
      c._ticks.forEach((p, ti) => {
        pts.push({ x: x0 - xW * 0.5 + step * ti + step * 0.5, y: yFor(p) });
      });
    } else {
      const r1 = seededRandom(Math.floor(c.ts / 1000), 11);
      const r2 = seededRandom(Math.floor(c.ts / 1000), 22);
      const r3 = seededRandom(Math.floor(c.ts / 1000), 33);
      const r4 = seededRandom(Math.floor(c.ts / 1000), 44);
      const isUp = c.close >= c.open;

      pts.push({ x: x0 - xW * 0.48, y: yFor(c.open) });
      const earlyProbe = isUp
        ? c.open - (c.open - c.low)  * (0.15 + r1 * 0.35)
        : c.open + (c.high - c.open) * (0.12 + r2 * 0.30);
      pts.push({ x: x0 - xW * 0.18, y: yFor(earlyProbe) });
      pts.push({ x: x0 + xW * (0.05 + r3 * 0.20), y: yFor(isUp ? c.high : c.low) });
      const cons = isUp
        ? c.high - (c.high - c.close) * (0.4 + r4 * 0.35)
        : c.low  + (c.close - c.low)  * (0.4 + r4 * 0.35);
      pts.push({ x: x0 + xW * 0.28, y: yFor(cons) });
    }
  }
  pts.push({ x: xFor(candles.length - 1) + xW * 0.48, y: yFor(candles[candles.length - 1].close) });

  function buildPath() {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1], curr = pts[i];
      const cpx = prev.x + (curr.x - prev.x) * 0.22;
      const cpy = prev.y;
      ctx.quadraticCurveTo(cpx, cpy, curr.x, curr.y);
    }
  }

  const bottom   = padT + plotH;
  const firstPt  = pts[0];
  const lastPt   = pts[pts.length - 1];

  buildPath();
  ctx.lineTo(lastPt.x, bottom);
  ctx.lineTo(firstPt.x, bottom);
  ctx.closePath();
  const areaGrad = ctx.createLinearGradient(0, padT, 0, bottom);
  areaGrad.addColorStop(0,   `rgba(${rgb},0.20)`);
  areaGrad.addColorStop(0.5, `rgba(${rgb},0.06)`);
  areaGrad.addColorStop(1,   `rgba(${rgb},0)`);
  ctx.fillStyle = areaGrad;
  ctx.fill();

  ctx.save();
  buildPath();
  ctx.shadowColor = `rgba(${rgb},0.55)`;
  ctx.shadowBlur  = 10;
  ctx.strokeStyle = `rgba(${rgb},0.5)`;
  ctx.lineWidth   = 3.5;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();

  buildPath();
  ctx.strokeStyle = color;
  ctx.lineWidth   = 1.5;
  ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.stroke();

  drawPulseDot(lastPt.x, lastPt.y);
}

function drawPulseDot(x, y) {
  const bill = cssVar("--bill") || "#ffc94d";
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, 7, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(255,201,77,0.18)";
  ctx.fill();
  ctx.beginPath();
  ctx.arc(x, y, 3.5, 0, Math.PI * 2);
  ctx.fillStyle = bill;
  ctx.shadowColor = bill;
  ctx.shadowBlur = 8;
  ctx.fill();
  ctx.restore();
}

function drawTradeMarkers() {
  if (!chartLayout) return;
  const { candles, xFor, yFor, bucketMs, min, max, padT, padB, h } = chartLayout;
  if (!candles.length) return;
  const firstTs = candles[0].ts, lastTs = candles[candles.length - 1].ts + bucketMs;
  // Show recent trades on every timeframe, not just the ones that happen to land
  // inside the current window. Trades older than the visible range are clamped
  // to the leftmost candle instead of being dropped, so avatars keep showing up
  // on "Live"/"1m"/etc. even when no trade occurred in the last few minutes.
  const visible = trades.filter(t => t.ts < lastTs).slice(0, 120);

  const bucketToIdx = new Map();
  candles.forEach((c, i) => bucketToIdx.set(c.ts, i));

  const markerData = [];
  for (const t of visible) {
    let idx;
    if (t.ts < firstTs) {
      idx = 0; // older than the visible window -- pin to the left edge
    } else {
      const tradeBucket = Math.floor(t.ts / bucketMs) * bucketMs;
      idx = bucketToIdx.has(tradeBucket)
        ? bucketToIdx.get(tradeBucket)
        : Math.min(candles.length - 1, Math.max(0, Math.floor((t.ts - firstTs) / bucketMs)));
    }
    idx = Math.min(candles.length - 1, Math.max(0, idx));

    const x = xFor(idx);
    const candle = candles[idx];
    const anchorPrice = t.price != null && t.price >= min && t.price <= max
      ? t.price
      : candle.close;
    const y = yFor(anchorPrice);

    const plotTop = padT + 10, plotBottom = h - padB - 10;
    const cy = Math.min(plotBottom, Math.max(plotTop, y));
    markerData.push({ ...t, _x: x, _y: cy });
  }

  // Cluster overlapping markers so avatars don't pile up
  const clustered = clusterMarkers(markerData, 18);

  for (const m of clustered) {
    const { _x: x, _y: y } = m;
    const color = m.type === "buy" ? (cssVar("--toxic") || "#7cff6b") : (cssVar("--venom") || "#ff3d6e");

    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, 9, 0, Math.PI * 2);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.fillStyle = "rgba(11,14,12,0.9)";
    ctx.fill();
    ctx.stroke();

    const img = getAvatarImg(m.avatarUrl);
    if (img.complete && img.naturalWidth) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, x - 7, y - 7, 14, 14);
      ctx.restore();
    }

    // Draw count badge if clustered
    if (m._count > 1) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(x + 6, y - 6, 6, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.fillStyle = "#0b0e0c";
      ctx.font = "bold 7px JetBrains Mono, monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(m._count > 9 ? "9+" : m._count, x + 6, y - 6);
      ctx.restore();
    }

    ctx.restore();
  }
  chartLayout.visibleTrades = markerData;

  drawTriggerLines();
}

function drawTriggerLines() {
  if (!chartLayout) return;
  const { yFor, w, padL, padR, min, max } = chartLayout;

  function drawHLine(price, kind, label) {
    if (!price || price <= 0) return;
    if (price < min || price > max) return;
    const y = yFor(price);
    const rgb = kind === "sl" ? "255,61,110" : "124,255,107";
    const hex  = kind === "sl" ? "#ff3d6e"    : "#7cff6b";
    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.strokeStyle = "rgba(" + rgb + ",0.7)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(w - padR + 6, y);
    ctx.stroke();
    ctx.setLineDash([]);
    const txt = label + " " + fmtPrice(price);
    ctx.font = "bold 9px JetBrains Mono, monospace";
    const tw = ctx.measureText(txt).width;
    const px = w - padR + 10, py = y, pw = tw + 8, ph = 14;
    roundRectPath(ctx, px, py - ph/2, pw, ph, 3);
    ctx.fillStyle = "rgba(" + rgb + ",0.18)";
    ctx.fill();
    ctx.strokeStyle = hex; ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = hex; ctx.textBaseline = "middle";
    ctx.fillText(txt, px + 4, py);
    ctx.restore();
  }

  if (stopLossPrice)   drawHLine(stopLossPrice,   "sl", "SL");
  if (takeProfitPrice) drawHLine(takeProfitPrice,  "tp", "TP");
}

function clusterMarkers(markers, radius) {
  const out = [];
  const used = new Set();
  for (let i = 0; i < markers.length; i++) {
    if (used.has(i)) continue;
    const m = { ...markers[i], _count: 1 };
    for (let j = i + 1; j < markers.length; j++) {
      if (used.has(j)) continue;
      const dx = markers[j]._x - m._x, dy = markers[j]._y - m._y;
      if (Math.sqrt(dx * dx + dy * dy) < radius) {
        used.add(j);
        m._count++;
      }
    }
    used.add(i);
    out.push(m);
  }
  return out;
}

function drawHoverTooltip() {
  const tip = el("chartTooltip");
  if (!hoverPoint || !chartLayout) { tip.classList.add("hidden"); return; }

  const trade = (chartLayout.visibleTrades || []).find(t => Math.hypot(t._x - hoverPoint.x, t._y - hoverPoint.y) < 10);
  if (trade) {
    tip.classList.remove("hidden");
    tip.style.left = Math.min(hoverPoint.x + 14, chartLayout.w - 170) + "px";
    tip.style.top = Math.max(hoverPoint.y - 50, 4) + "px";
    const callingHtml = trade.callingIt ? `<br/><em>"${escapeHtml(trade.callingIt)}"</em>` : "";
    tip.innerHTML = `<strong>${escapeHtml(trade.username)}</strong><br/>${trade.type === "buy" ? "Bought" : "Sold"} ${fmtUsd(trade.usdAmount)}<br/>@ ${fmtPrice(trade.price)}${callingHtml}`;
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
  if (chartType === "line") {
    tip.innerHTML = `${d.toLocaleTimeString()}<br/><strong>${fmtPrice(closest.close)}</strong>`;
  } else {
    tip.innerHTML = `${d.toLocaleTimeString()}<br/>O ${fmtPrice(closest.open)} H ${fmtPrice(closest.high)}<br/>L ${fmtPrice(closest.low)} C ${fmtPrice(closest.close)}`;
  }
}

canvas.addEventListener("mousemove", (e) => {
  const rect = canvas.getBoundingClientRect();
  hoverPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
  drawHoverTooltip();
});
canvas.addEventListener("mouseleave", () => { hoverPoint = null; el("chartTooltip").classList.add("hidden"); });

// Touch hover for chart tooltip on mobile
canvas.addEventListener("touchmove", (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  hoverPoint = { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
  drawHoverTooltip();
}, { passive: false });
canvas.addEventListener("touchend", () => { hoverPoint = null; el("chartTooltip").classList.add("hidden"); });

// Safety redraw: fires if the tick loop somehow missed a cycle
setInterval(() => { if (booted) drawChart(); }, 1000);

// ===========================================================
// TRADE SHEET
// ===========================================================
// Remember whether the user last chose "Max" for each mode
const sheetLastMax = { buy: false, sell: false };

function applyMaxAmount(mode) {
  const price = marketState.price || STARTING_PRICE;
  if (mode === "buy") {
    sheetSellAll = false;
    sheetAmount = String(Math.floor((currentUser?.balance || 0) * 100) / 100);
  } else {
    sheetSellAll = true;
    const usdVal = (currentUser?.holdings || 0) * price;
    sheetAmount = String(Math.floor(usdVal * 100) / 100);
  }
}

function isSheetOpen() {
  return !el("sheetBackdrop").classList.contains("hidden");
}

// Called on every market state update — if sheet is open and user picked Max,
// refresh sell-max amount so it tracks the live coin price.
function refreshSheetIfMaxActive() {
  if (!isSheetOpen()) return;
  if (sheetSellAll) {
    applyMaxAmount("sell");
    renderSheetAmount();
    renderSheetConvert();
  }
}

function openSheet(mode) {
  sheetMode = mode;
  sheetSellAll = false;
  sheetAmount = "";
  el("sheetError").textContent = "";
  el("callingItInput").value = "";
  el("sheetTitle").textContent = mode === "buy" ? "Buy $PLTY" : "Sell $PLTY";
  el("slideLabel").textContent = mode === "buy" ? "Slide to Buy" : "Slide to Sell";
  el("slideConfirm").querySelector(".slide-track").className = "slide-track" + (mode === "sell" ? " selling" : "");
  resetSlider();

  // Auto-apply max if the user chose it last time for this mode
  if (sheetLastMax[mode]) {
    applyMaxAmount(mode);
  }

  // Render quick buttons for the current mode
  renderQuickBtns();

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
    el("sheetConvert").textContent = `≈ ${(amt / price).toFixed(8)} PLTY worth`;
  }
}

el("keypad").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const k = btn.dataset.k;
  sheetSellAll = false;
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
    sheetLastMax[sheetMode] = false; // user picked a fixed amount, clear max memory
    sheetSellAll = false;
    sheetAmount = btn.dataset.amt;
  } else if (btn.dataset.max) {
    sheetLastMax[sheetMode] = true; // remember they want max for next open
    applyMaxAmount(sheetMode);
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
  e.preventDefault();
  dragging = true;
  dragStartX = (e.touches ? e.touches[0].clientX : e.clientX);
  const t = slideThumb.style.transform.match(/-?\d+/);
  thumbStartX = t ? parseFloat(t[0]) : 0;
  slideThumb.style.cursor = "grabbing";
}
function onPointerMove(e) {
  if (!dragging) return;
  e.preventDefault();
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
slideThumb.addEventListener("mousedown", onPointerDown, { passive: false });
slideThumb.addEventListener("touchstart", onPointerDown, { passive: false });
window.addEventListener("mousemove", onPointerMove, { passive: false });
window.addEventListener("touchmove", onPointerMove, { passive: false });
window.addEventListener("mouseup", onPointerUp);
window.addEventListener("touchend", onPointerUp);

async function confirmTrade() {
  const amt = parseFloat(sheetAmount || "0") || 0;
  const errEl = el("sheetError");
  errEl.textContent = "";
  if (amt <= 0) { errEl.textContent = "Enter an amount first."; resetSlider(); return; }

  slideTrackWrap.querySelector(".slide-track").classList.add("confirmed");

  const callingIt = el("callingItInput").value.trim().slice(0, 60);

  try {
    _lastTradeWasLocal = false;
    await executeTrade(sheetMode, amt, sheetSellAll, callingIt);
    // Skip success toast for local sells — _executeLocalSell already showed the quota warning
    if (!_lastTradeWasLocal) {
      toast(`${sheetMode === "buy" ? "Bought" : "Sold"} ${fmtUsd(amt)} of $PLTY`, false);
    }
    sheetLastMax[sheetMode] = false; // reset so next open doesn't auto-fill stale max
    setTimeout(closeSheet, 450);
  } catch (e) {
    errEl.textContent = e.message || "Trade failed.";
    resetSlider();
  }
}

async function executeTrade(mode, usdAmount, sellAll = false, callingIt = "", silent = false) {
  const uref = doc(usersCol, currentUser.uid);
  const IMPACT_FACTOR = 2.2;

  // Capture the live local price BEFORE entering the transaction.
  // marketRef is only written every ~15s (5 ticks) for efficiency, so reading it
  // inside the transaction would give a stale price — sometimes 35%+ behind the
  // live price the user sees. We use _lastKnownPrice (updated every 3s tick) so
  // the trade executes at the price shown in the UI, not an old Firestore value.
  // The transaction still WRITES the post-trade price to marketRef to sync other tabs.
  const livePrice = _lastKnownPrice || marketState.price || STARTING_PRICE;

  try {
    await runTransaction(db, async (tx) => {
      // Only read the user doc from Firestore — we supply the live price ourselves.
      const userSnap = await tx.get(uref);
      if (!userSnap.exists()) throw new Error("Not ready, try again.");
      let price = livePrice;
      const marketCapNow = price * TOTAL_SUPPLY;
      const u = userSnap.data();
      let balance = u.balance || 0;
      let holdings = u.holdings || 0;
      let costBasis = u.costBasis || 0;

      if (mode === "buy") {
        if (usdAmount > balance + 1e-9) throw new Error("Not enough cash.");
        const coinAmount = usdAmount / price;
        const impact = Math.min(0.25, (usdAmount / marketCapNow) * IMPACT_FACTOR);
        price = price * (1 + impact);
        balance -= usdAmount;
        costBasis += usdAmount; // track total cost for P&L
        holdings += coinAmount;
        tx.update(marketRef, { price, marketCap: price * TOTAL_SUPPLY, lastTickIndex: _lastKnownTickIdx });
        tx.update(uref, { balance, holdings, costBasis });
        const tradeDoc = doc(tradesCol);
        tx.set(tradeDoc, {
          uid: currentUser.uid, username: currentUser.username, avatarUrl: currentUser.avatarUrl || DEFAULT_AVATAR,
          type: "buy", usdAmount, coinAmount, price, callingIt: callingIt || "",
          timestamp: serverTimestamp()
        });
      } else {
        const priceNow = livePrice; // use the same captured live price, not stale Firestore
        // Re-read holdings from the transaction snapshot (not from cached currentUser)
        // so stale transaction retries see the real value and don't sell dust/zero.
        const liveHoldings = u.holdings || 0;
        if (liveHoldings < 1e-9) throw new Error("No $PLTY held.");
        const coinAmount = sellAll ? liveHoldings : Math.min(usdAmount / priceNow, liveHoldings);
        if (coinAmount < 1e-9) throw new Error("Amount too small.");
        if (coinAmount > liveHoldings + 1e-9) throw new Error("Not enough $PLTY held.");
        const usdReceived = coinAmount * priceNow;
        const impact = Math.min(0.25, (usdReceived / marketCapNow) * IMPACT_FACTOR);
        price = priceNow * (1 - impact);
        balance += usdReceived;
        // Reduce costBasis proportionally using live server value
        const sellRatio = liveHoldings > 0 ? coinAmount / liveHoldings : 0;
        costBasis = costBasis * (1 - sellRatio);
        holdings = liveHoldings - coinAmount;
        if (holdings < 1e-9) { holdings = 0; costBasis = 0; }
        tx.update(marketRef, { price, marketCap: price * TOTAL_SUPPLY, lastTickIndex: _lastKnownTickIdx });
        tx.update(uref, { balance, holdings, costBasis });
        const tradeDoc = doc(tradesCol);
        tx.set(tradeDoc, {
          uid: currentUser.uid, username: currentUser.username, avatarUrl: currentUser.avatarUrl || DEFAULT_AVATAR,
          type: "sell", usdAmount: usdReceived, coinAmount, price, callingIt: callingIt || "",
          timestamp: serverTimestamp()
        });
      }
    });
    // Successful Firestore transaction — clear quota flag
    _firestoreQuotaExceeded = false;
    _lastTradeWasLocal = false;
  } catch (err) {
    // Detect quota-exceeded / resource-exhausted errors from Firestore
    const isQuotaErr = err.code === "resource-exhausted" ||
      (err.message && (err.message.includes("Quota exceeded") || err.message.includes("resource-exhausted") || err.message.includes("RESOURCE_EXHAUSTED")));

    // For sells: apply locally and queue for retry so the user isn't trapped
    if (isQuotaErr && mode === "sell") {
      _firestoreQuotaExceeded = true;
      _lastTradeWasLocal = true;
      _executeLocalSell(usdAmount, sellAll, callingIt);
      return; // local sell succeeded — don't throw
    }

    throw err; // re-throw for buys and non-quota errors
  }
}

// Apply a sell locally using cached state when Firestore is unavailable
function _executeLocalSell(usdAmount, sellAll, callingIt) {
  const price = marketState.price || STARTING_PRICE;
  const liveHoldings = currentUser.holdings || 0;
  if (liveHoldings < 1e-9) throw new Error("No $PLTY held.");
  const coinAmount = sellAll ? liveHoldings : Math.min(usdAmount / price, liveHoldings);
  if (coinAmount < 1e-9) throw new Error("Amount too small.");
  const usdReceived = coinAmount * price;

  // Update local currentUser so the UI reflects the sell immediately
  const sellRatio = liveHoldings > 0 ? coinAmount / liveHoldings : 0;
  currentUser.holdings = Math.max(0, liveHoldings - coinAmount);
  currentUser.balance = (currentUser.balance || 0) + usdReceived;
  currentUser.costBasis = (currentUser.costBasis || 0) * (1 - sellRatio);
  if (currentUser.holdings < 1e-9) { currentUser.holdings = 0; currentUser.costBasis = 0; }

  // Queue this sell so it can be committed to Firestore when quota resets
  _pendingSellQueue.push({ usdAmount: usdReceived, coinAmount, sellAll: false, callingIt, ts: Date.now() });
  _savePendingSells();

  // Re-render wallet and show a warning
  renderWallet();
  toast(`⚠ Sold locally (quota limit) — will sync when quota resets`, false);
}

// ===========================================================
// QUICK TRADE BUTTONS
// ===========================================================
const DEFAULT_QB_LABELS = (v) => `$${v}`;
const DEFAULT_QS_LABELS = (v) => `${v}%`;

function renderQuickBtns() {
  const container = el("quickBtns");
  if (!container) return;
  container.innerHTML = "";

  if (sheetMode === "buy") {
    quickBuys.filter(v => v > 0).forEach(amt => {
      const b = document.createElement("button");
      b.className = "quick-btn qb";
      b.textContent = `$${amt}`;
      b.addEventListener("click", () => {
        sheetSellAll = false;
        sheetAmount = String(amt);
        renderSheetAmount();
        renderSheetConvert();
      });
      container.appendChild(b);
    });
  } else {
    quickSells.filter(v => v > 0).forEach(pct => {
      const b = document.createElement("button");
      b.className = "quick-btn qs";
      b.textContent = `${pct}%`;
      b.addEventListener("click", () => {
        const price = marketState.price || STARTING_PRICE;
        const holdings = currentUser?.holdings || 0;
        const usdVal = holdings * price;
        sheetSellAll = pct === 100;
        sheetAmount = String(Math.floor((usdVal * pct / 100) * 100) / 100);
        renderSheetAmount();
        renderSheetConvert();
      });
      container.appendChild(b);
    });
  }
}

function renderQuickTradePreview() {
  const preview = el("quickPreview");
  if (!preview) return;
  const buyChips = quickBuys.filter(v => v > 0)
    .map(v => `<span class="quick-preview-chip buy">$${v}</span>`).join("");
  const sellChips = quickSells.filter(v => v > 0)
    .map(v => `<span class="quick-preview-chip sell">${v}%</span>`).join("");
  preview.innerHTML = buyChips + sellChips ||
    `<span style="color:var(--text-faint);font-size:11px">No quick buttons set</span>`;
}

function saveQuickTrade() {
  if (!currentUser) return;
  updateDoc(doc(usersCol, currentUser.uid), { quickBuys, quickSells }).catch(() => {});
}

function setupQuickTradeUI() {
  renderQuickTradePreview();

  el("quickEditBtn").addEventListener("click", () => {
    const editor = el("quickEditor");
    const isOpen = !editor.classList.contains("hidden");
    editor.classList.toggle("hidden", isOpen);
    el("quickEditBtn").textContent = isOpen ? "Edit" : "Done";
    if (!isOpen) {
      // Populate inputs with current values
      ["qb0","qb1","qb2"].forEach((id, i) => {
        el(id).value = quickBuys[i] > 0 ? quickBuys[i] : "";
      });
      ["qs0","qs1","qs2"].forEach((id, i) => {
        el(id).value = quickSells[i] > 0 ? quickSells[i] : "";
      });
    }
  });

  el("quickSaveBtn").addEventListener("click", () => {
    quickBuys  = ["qb0","qb1","qb2"].map(id => parseFloat(el(id).value) || 0);
    quickSells = ["qs0","qs1","qs2"].map(id => {
      const v = parseFloat(el(id).value) || 0;
      return Math.min(100, Math.max(0, v));
    });
    saveQuickTrade();
    renderQuickTradePreview();
    renderQuickBtns();
    el("quickEditor").classList.add("hidden");
    el("quickEditBtn").textContent = "Edit";
    toast("Quick buttons saved", false);
  });
}

// ===========================================================
// STOP-LOSS / TAKE-PROFIT
// ===========================================================
function loadTriggers() {
  // Read localStorage for instant render before Firestore snapshot arrives.
  // subscribeUser() will overwrite with the authoritative Firestore values.
  const saved = localStorage.getItem("plty_triggers");
  if (saved) {
    try {
      const { sl, tp } = JSON.parse(saved);
      stopLossPrice = sl || null;
      takeProfitPrice = tp || null;
      renderTriggerStatus();
    } catch (_) {}
  }
}

function saveTriggers() {
  // Persist to Firestore so triggers survive page reloads and work across devices.
  // localStorage is kept as a fast-read fallback for initial render before snapshot arrives.
  localStorage.setItem("plty_triggers", JSON.stringify({ sl: stopLossPrice, tp: takeProfitPrice }));
  if (!currentUser) return;
  updateDoc(doc(usersCol, currentUser.uid), {
    stopLoss:   stopLossPrice   || null,
    takeProfit: takeProfitPrice || null
  }).catch(() => {});
}

function setupTriggerUI() {
  el("slBtn").addEventListener("click", () => {
    const v = parseFloat(el("slInput").value);
    if (!v || v <= 0) { stopLossPrice = null; } else { stopLossPrice = v; }
    saveTriggers();
    renderTriggerStatus();
    toast(stopLossPrice ? `Stop-loss set at ${fmtPrice(stopLossPrice)}` : "Stop-loss cleared", false);
    drawChart();
  });
  el("tpBtn").addEventListener("click", () => {
    const v = parseFloat(el("tpInput").value);
    if (!v || v <= 0) { takeProfitPrice = null; } else { takeProfitPrice = v; }
    saveTriggers();
    renderTriggerStatus();
    toast(takeProfitPrice ? `Take-profit set at ${fmtPrice(takeProfitPrice)}` : "Take-profit cleared", false);
    drawChart();
  });
}

function renderTriggerStatus() {
  const parts = [];
  if (stopLossPrice) {
    el("slInput").value = stopLossPrice;
    el("slBtn").classList.add("active");
    parts.push(`SL ${fmtPrice(stopLossPrice)}`);
  } else {
    el("slBtn").classList.remove("active");
  }
  if (takeProfitPrice) {
    el("tpInput").value = takeProfitPrice;
    el("tpBtn").classList.add("active");
    parts.push(`TP ${fmtPrice(takeProfitPrice)}`);
  } else {
    el("tpBtn").classList.remove("active");
  }
  el("triggerStatus").textContent = parts.length ? "Active: " + parts.join(" · ") : "No triggers set";
}

async function checkTriggers() {
  if (!currentUser || triggersExecuting) return;
  const price = marketState.price;
  if (!price) return;
  const holdings = currentUser.holdings || 0;
  if (holdings <= 0) return;

  let shouldSell = false;
  let reason = "";

  if (stopLossPrice && price <= stopLossPrice) {
    shouldSell = true;
    reason = `Stop-loss triggered at ${fmtPrice(price)}`;
  } else if (takeProfitPrice && price >= takeProfitPrice) {
    shouldSell = true;
    reason = `Take-profit triggered at ${fmtPrice(price)}`;
  }

  if (!shouldSell) return;

  // Snapshot trigger prices for restoration if the trade fails.
  const _triggerSlBackup = stopLossPrice;
  const _triggerTpBackup = takeProfitPrice;

  // Set flag SYNCHRONOUSLY before any await so concurrent snapshot callbacks
  // can't slip through and trigger a second sell while the first is in-flight.
  triggersExecuting = true;
  stopLossPrice = null;
  takeProfitPrice = null;
  saveTriggers();
  renderTriggerStatus();
  drawChart();

  try {
    await executeTrade("sell", 0, true, "", true); // sellAll=true, amount ignored
    toast(`🤖 ${reason} — sold all PLTY`, false);
  } catch (e) {
    // Restore triggers so the user doesn't silently lose them on a failed execution
    stopLossPrice   = _triggerSlBackup;
    takeProfitPrice = _triggerTpBackup;
    saveTriggers();
    renderTriggerStatus();
    drawChart();
    toast("Trigger failed: " + e.message + " — triggers restored", true);
  } finally {
    triggersExecuting = false;
  }
}

// ===========================================================
// PRICE ALERTS (browser notifications)
// ===========================================================
function loadAlerts() {
  const saved = localStorage.getItem("plty_alerts");
  if (saved) {
    try {
      const { above, below } = JSON.parse(saved);
      alertAbovePrice = above || null;
      alertBelowPrice = below || null;
      alertAboveFired = false;
      alertBelowFired = false;
    } catch (_) {}
  }
}

function saveAlerts() {
  localStorage.setItem("plty_alerts", JSON.stringify({ above: alertAbovePrice, below: alertBelowPrice }));
}

function setupAlertUI() {
  el("alertSetBtn").addEventListener("click", async () => {
    const above = parseFloat(el("alertAbove").value) || null;
    const below = parseFloat(el("alertBelow").value) || null;

    // Request notification permission
    if ((above || below) && "Notification" in window) {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") {
        el("alertStatus").textContent = "⚠ Notifications blocked — please allow in browser settings";
        return;
      }
    }

    alertAbovePrice = above;
    alertBelowPrice = below;
    alertAboveFired = false;
    alertBelowFired = false;
    saveAlerts();

    const parts = [];
    if (above) parts.push(`above ${fmtPrice(above)}`);
    if (below) parts.push(`below ${fmtPrice(below)}`);
    el("alertStatus").textContent = parts.length ? "✓ Alert set: " + parts.join(" or ") : "Alerts cleared";
    if (parts.length) toast("Price alert saved", false);
  });
}

function checkAlerts() {
  const price = marketState.price;
  if (!price) return;

  if (alertAbovePrice && !alertAboveFired && price >= alertAbovePrice) {
    alertAboveFired = true;
    sendAlert(`$PLTY above ${fmtPrice(alertAbovePrice)}`, `Current price: ${fmtPrice(price)}`);
  }
  if (alertBelowPrice && !alertBelowFired && price <= alertBelowPrice) {
    alertBelowFired = true;
    sendAlert(`$PLTY below ${fmtPrice(alertBelowPrice)}`, `Current price: ${fmtPrice(price)}`);
  }
}

function sendAlert(title, body) {
  toast(`🔔 ${title} — ${body}`, false);
  if ("Notification" in window && Notification.permission === "granted") {
    try {
      new Notification(title, { body, icon: DEFAULT_AVATAR });
    } catch (_) {}
  }
}

// ===========================================================
// REFERRAL
// ===========================================================
function setupReferral() {
  el("copyRefBtn").addEventListener("click", () => {
    if (!currentUser) return;
    const url = `${location.origin}${location.pathname}?ref=${encodeURIComponent(currentUser.username)}`;
    navigator.clipboard.writeText(url).then(() => {
      toast("Referral link copied!", false);
    }).catch(() => {
      prompt("Copy your referral link:", url);
    });
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
  PANELS.forEach(p => {
    el("panel" + p[0].toUpperCase() + p.slice(1)).classList.toggle("hidden", p !== "wallet");
  });
  drawSparkline();
});

el("logoutBtn").addEventListener("click", async () => {
  await auth.signOut();
  location.reload();
});
