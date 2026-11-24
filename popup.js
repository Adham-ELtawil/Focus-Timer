// Popup UI. All authoritative timing lives in background.js; the popup just
// reads state, renders it, and ticks the display locally for smoothness.

const RING_CIRCUMFERENCE = 2 * Math.PI * 100; // r=100 in the SVG

const els = {
  // tabs / modes
  tabTimer: document.getElementById("tabTimer"),
  tabStopwatch: document.getElementById("tabStopwatch"),
  tabIndicator: document.querySelector(".tabs__indicator"),
  timerMode: document.getElementById("timerMode"),
  stopwatchMode: document.getElementById("stopwatchMode"),
  // sub-tabs (standard / pomodoro)
  subStandard: document.getElementById("subStandard"),
  subPomodoro: document.getElementById("subPomodoro"),
  subIndicator: document.querySelector(".sub-tabs__indicator"),
  // timer
  setupView: document.getElementById("setupView"),
  pomoSetup: document.getElementById("pomoSetup"),
  activeView: document.getElementById("activeView"),
  hoursInput: document.getElementById("hoursInput"),
  minutesInput: document.getElementById("minutesInput"),
  secondsInput: document.getElementById("secondsInput"),
  focusMsgInput: document.getElementById("focusMsgInput"),
  startBtn: document.getElementById("startBtn"),
  pomoStartBtn: document.getElementById("pomoStartBtn"),
  presets: document.querySelectorAll(".preset"),
  countdown: document.querySelector(".countdown"),
  timeDisplay: document.getElementById("timeDisplay"),
  stateLabel: document.getElementById("stateLabel"),
  progressRing: document.getElementById("progressRing"),
  pauseBtn: document.getElementById("pauseBtn"),
  skipBtn: document.getElementById("skipBtn"),
  resetBtn: document.getElementById("resetBtn"),
  controls: document.querySelector(".controls"),
  pauseBlockNote: document.getElementById("pauseBlockNote"),
  phasePill: document.getElementById("phasePill"),
  cycleDots: document.getElementById("cycleDots"),
  pomoNextBtn: document.getElementById("pomoNextBtn"),
  // stopwatch
  swTime: document.getElementById("swTime"),
  swState: document.getElementById("swState"),
  swDisplay: document.querySelector(".sw-display"),
  swMainBtn: document.getElementById("swMainBtn"),
  swLapBtn: document.getElementById("swLapBtn"),
  swResetBtn: document.getElementById("swResetBtn"),
  swControls: document.querySelector(".sw-controls"),
  lapList: document.getElementById("lapList"),
  // world clock
  tzInput: document.getElementById("tzInput"),
  tzAddBtn: document.getElementById("tzAddBtn"),
  tzClocks: document.getElementById("tzClocks"),
  tzToggle: document.getElementById("tzToggle"),
  tzInputWrap: document.getElementById("tzInputWrap"),
  // custom pomodoro inputs
  pomoFocusInput: document.getElementById("pomoFocusInput"),
  pomoBreakInput: document.getElementById("pomoBreakInput"),
  pomoLongInput: document.getElementById("pomoLongInput"),
  // review nudge
  reviewNudge: document.getElementById("reviewNudge"),
  // what's new
  whatsNew: document.getElementById("whatsNew"),
  whatsNewVersion: document.getElementById("whatsNewVersion"),
  whatsNewList: document.getElementById("whatsNewList"),
  whatsNewClose: document.getElementById("whatsNewClose"),
  // block list
  blockToggle: document.getElementById("blockToggle"),
  blockPower: document.getElementById("blockPower"),
  blockWrap: document.getElementById("blockWrap"),
  blockEmpty: document.getElementById("blockEmpty"),
  blockInput: document.getElementById("blockInput"),
  blockAddBtn: document.getElementById("blockAddBtn"),
  blockPresets: document.getElementById("blockPresets"),
};

let cached = null; // last timer state
let ticker = null; // timer interval
let swCached = null; // last stopwatch state
let swTicker = null; // stopwatch interval
let swLapCount = 0; // rendered laps

function send(message) {
  // Never let a stale/asleep/unresponsive worker throw into the UI.
  return chrome.runtime.sendMessage(message).catch((err) => {
    console.warn("Focus Timer: message failed", message, err);
    return null;
  });
}

// The stopwatch persists itself directly via chrome.storage.local. Because we
// store an absolute startTime, elapsed time is recomputed correctly whenever
// the popup reopens — no running background process required.
const SW_KEY = "stopwatchState";
const MODE_KEY = "activeMode";
const LABEL_KEY = "focusLabel";
const SUB_MODE_KEY = "timerSubMode"; // "standard" | "pomodoro"

// Pomodoro defaults
const POMO_FOCUS_DEFAULT = 25;
const POMO_BREAK_DEFAULT = 5;
const POMO_LONG_DEFAULT = 15;
const POMO_TOTAL_CYCLES = 4;

// Custom durations (minutes) — loaded from storage on init
const POMO_CUSTOM_KEY = "pomoCustom";
let pomoCustom = { focus: POMO_FOCUS_DEFAULT, break: POMO_BREAK_DEFAULT, longBreak: POMO_LONG_DEFAULT };

async function pomoCustomRead() {
  try {
    const data = await chrome.storage.local.get(POMO_CUSTOM_KEY);
    const s = data[POMO_CUSTOM_KEY];
    if (s && typeof s === "object") {
      return {
        focus:     clampPomoMin(s.focus,     1, 99, POMO_FOCUS_DEFAULT),
        break:     clampPomoMin(s.break,     1, 59, POMO_BREAK_DEFAULT),
        longBreak: clampPomoMin(s.longBreak, 1, 99, POMO_LONG_DEFAULT),
      };
    }
  } catch { /* ignore */ }
  return { focus: POMO_FOCUS_DEFAULT, break: POMO_BREAK_DEFAULT, longBreak: POMO_LONG_DEFAULT };
}

function clampPomoMin(val, min, max, fallback) {
  const n = parseInt(val, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function pomoCustomWrite() {
  chrome.storage.local.set({ [POMO_CUSTOM_KEY]: pomoCustom }).catch(() => { });
}

function syncPomoInputs() {
  els.pomoFocusInput.value = pomoCustom.focus;
  els.pomoBreakInput.value = pomoCustom.break;
  els.pomoLongInput.value  = pomoCustom.longBreak;
}

let timerSubMode = "standard"; // current sub-mode

// The popup persists the focus message itself so it shows even if the service
// worker is asleep or running an older build that doesn't echo it back.
let focusLabel = "";

async function labelRead() {
  try {
    const data = await chrome.storage.local.get(LABEL_KEY);
    return typeof data[LABEL_KEY] === "string" ? data[LABEL_KEY] : "";
  } catch {
    return "";
  }
}

function labelWrite(label) {
  focusLabel = label;
  chrome.storage.local.set({ [LABEL_KEY]: label }).catch(() => { });
}

async function swRead() {
  try {
    const data = await chrome.storage.local.get(SW_KEY);
    return normalizeSw(data[SW_KEY]);
  } catch (err) {
    console.warn("Focus Timer: stopwatch read failed", err);
    return localReset();
  }
}

async function swWrite(state) {
  try {
    await chrome.storage.local.set({ [SW_KEY]: state });
  } catch (err) {
    console.warn("Focus Timer: stopwatch write failed", err);
  }
}

async function modeRead() {
  try {
    const data = await chrome.storage.local.get(MODE_KEY);
    return data[MODE_KEY] || "timer";
  } catch {
    return "timer";
  }
}

function modeWrite(mode) {
  chrome.storage.local.set({ [MODE_KEY]: mode }).catch(() => { });
}

// ---------- formatting ----------

function format(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  if (h > 0) {
    return (
      `${String(h).padStart(2, "0")}:` +
      `${String(m).padStart(2, "0")}:` +
      `${String(s).padStart(2, "0")}`
    );
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatSw(rawMs) {
  const ms = Number.isFinite(rawMs) && rawMs > 0 ? rawMs : 0;
  const totalCs = Math.floor(ms / 10);
  const cs = totalCs % 100;
  const totalSec = Math.floor(totalCs / 100);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600);
  return {
    main:
      `${String(h).padStart(2, "0")}:` +
      `${String(m).padStart(2, "0")}:` +
      `${String(s).padStart(2, "0")}`,
    cs: String(cs).padStart(2, "0"),
  };
}

// ============================================================
//  TIMER
// ============================================================

function liveRemaining(state) {
  if (state.status === "running" && state.endTime) {
    return Math.max(0, state.endTime - Date.now());
  }
  return state.remaining;
}

// Paints the countdown digits and shrinks them when an hours field is present
// so HH:MM:SS still fits inside the ring.
function setTimerDisplay(ms) {
  const text = format(ms);
  els.timeDisplay.textContent = text;
  els.countdown.classList.toggle("has-hours", text.length > 5);
}

function renderSetup() {
  els.activeView.classList.add("hidden");
  els.countdown.classList.remove("is-running", "is-done");
  els.phasePill.classList.add("hidden");
  els.cycleDots.classList.add("hidden");
  els.pomoNextBtn.classList.add("hidden");
  stopTicker();
  // Show the right setup view based on sub-mode
  if (timerSubMode === "pomodoro") {
    els.setupView.classList.add("hidden");
    els.pomoSetup.classList.remove("hidden");
  } else {
    els.setupView.classList.remove("hidden");
    els.pomoSetup.classList.add("hidden");
  }
}

function renderActive(state) {
  els.setupView.classList.add("hidden");
  els.pomoSetup.classList.add("hidden");
  els.activeView.classList.remove("hidden");

  const remaining = liveRemaining(state);
  setTimerDisplay(remaining);

  const total = state.totalDuration || 1;
  const fraction = Math.max(0, Math.min(1, remaining / total));
  els.progressRing.style.strokeDasharray = `${RING_CIRCUMFERENCE}`;
  els.progressRing.style.strokeDashoffset = `${RING_CIRCUMFERENCE * (1 - fraction)}`;

  els.countdown.classList.toggle("is-running", state.status === "running");
  els.countdown.classList.toggle("is-done", state.status === "done");

  const pomo = state.pomodoro;

  // ---------- Phase pill & ring color ----------
  if (pomo) {
    els.phasePill.classList.remove("hidden", "phase-pill--focus", "phase-pill--break", "phase-pill--long");
    els.countdown.classList.remove("phase-focus", "phase-break", "phase-long");
    if (pomo.phase === "focus") {
      els.phasePill.textContent = "FOCUS";
      els.phasePill.classList.add("phase-pill--focus");
      els.countdown.classList.add("phase-focus");
    } else if (pomo.phase === "break") {
      els.phasePill.textContent = "BREAK";
      els.phasePill.classList.add("phase-pill--break");
      els.countdown.classList.add("phase-break");
    } else {
      els.phasePill.textContent = "LONG BREAK";
      els.phasePill.classList.add("phase-pill--long");
      els.countdown.classList.add("phase-long");
    }
    // Cycle dots
    renderCycleDots(pomo);
  } else {
    els.phasePill.classList.add("hidden");
    els.cycleDots.classList.add("hidden");
  }

  // ---------- Review nudge ----------
  els.reviewNudge.classList.toggle("hidden", state.status !== "done");
  els.reviewNudge.href = reviewUrl();

  // ---------- Done / running / paused ----------
  if (state.status === "done") {
    els.stateLabel.classList.add("is-done");
    els.stateLabel.classList.remove("has-label");
    els.pauseBtn.classList.add("hidden");
    els.skipBtn.classList.add("hidden");

    // Pause and Skip are hidden, so the remaining button should fill the row.
    els.controls.classList.add("single");
    els.controls.classList.remove("three");

    if (pomo && pomo.nextPhase) {
      els.stateLabel.textContent = phaseLabel(pomo.phase) + " Done";
      els.pomoNextBtn.classList.remove("hidden");
      const nextLabel = phaseLabel(pomo.nextPhase);
      els.pomoNextBtn.innerHTML = `<span class="btn__plus">\u25b6</span> Start ${nextLabel}`;
      els.resetBtn.textContent = "End";
    } else {
      els.stateLabel.textContent = "Done";
      els.pomoNextBtn.classList.add("hidden");
      els.resetBtn.textContent = "Dismiss";
    }
  } else {
    els.stateLabel.classList.remove("is-done");
    els.pauseBtn.classList.remove("hidden");
    els.pomoNextBtn.classList.add("hidden");
    els.resetBtn.textContent = "Reset";
    els.controls.classList.remove("single");

    // Show skip button only in pomodoro running/paused state
    els.skipBtn.classList.toggle("hidden", !pomo);
    els.controls.classList.toggle("three", !!pomo);

    if (state.status === "paused") {
      els.stateLabel.textContent = "Paused";
      els.stateLabel.classList.remove("has-label");
      els.pauseBtn.textContent = "Resume";
    } else {
      const lbl = pomo ? phaseLabel(pomo.phase) : (state.label || focusLabel);
      if (lbl) {
        els.stateLabel.textContent = lbl;
        els.stateLabel.classList.add("has-label");
        els.stateLabel.title = lbl;
      } else {
        els.stateLabel.textContent = "Focusing";
        els.stateLabel.classList.remove("has-label");
        els.stateLabel.removeAttribute("title");
      }
      els.pauseBtn.textContent = "Pause";
    }
  }

  syncPauseBlockNote(state);
}

function syncPauseBlockNote(state) {
  const focusPhase = !state.pomodoro || state.pomodoro.phase === "focus";
  const show = state.status === "paused" && blockEnabled && blocks.length > 0 && focusPhase;
  els.pauseBlockNote.classList.toggle("hidden", !show);
}

// The same build ships to both stores, so send each user to their own listing.
const CHROME_REVIEWS =
  "https://chromewebstore.google.com/detail/focus-timer/cikdgphmfeoofloohdplihbkpneaicke/reviews";
const EDGE_REVIEWS =
  "https://microsoftedge.microsoft.com/addons/detail/igjimgahamegincapeokibhkmfjimodd";

function reviewUrl() {
  return /\bEdg\//.test(navigator.userAgent) ? EDGE_REVIEWS : CHROME_REVIEWS;
}

function phaseLabel(phase) {
  if (phase === "focus") return "Focus";
  if (phase === "break") return "Break";
  return "Long Break";
}

function phaseDurationMs(phase) {
  if (phase === "focus") return pomoCustom.focus * 60 * 1000;
  if (phase === "break") return pomoCustom.break * 60 * 1000;
  return pomoCustom.longBreak * 60 * 1000;
}

function renderCycleDots(pomo) {
  els.cycleDots.classList.remove("hidden");
  let html = "";
  for (let i = 1; i <= POMO_TOTAL_CYCLES; i++) {
    const filled = i < pomo.cycle || (i === pomo.cycle && pomo.phase !== "focus");
    const active = i === pomo.cycle && pomo.phase === "focus";
    html += `<span class="cycle-dot${filled ? " filled" : ""}${active ? " active" : ""}"></span>`;
  }
  els.cycleDots.innerHTML = html;
}

function render(state) {
  // A stale/asleep worker can resolve to null; fall back so we never throw.
  if (!state || typeof state.status !== "string") {
    state = cached || { status: "idle", remaining: 0, totalDuration: 0 };
  }
  cached = state;
  if (state.status === "idle") {
    renderSetup();
  } else {
    renderActive(state);
    if (state.status === "running") startTicker();
    else stopTicker();
  }
}

function startTicker() {
  if (ticker) return;
  ticker = setInterval(async () => {
    if (!cached) return;
    const remaining = liveRemaining(cached);
    setTimerDisplay(remaining);

    const total = cached.totalDuration || 1;
    const fraction = Math.max(0, Math.min(1, remaining / total));
    els.progressRing.style.strokeDashoffset =
      `${RING_CIRCUMFERENCE * (1 - fraction)}`;

    if (remaining <= 0) {
      stopTicker();
      const state = await send({ type: "GET_STATE" });
      render(state);
    }
  }, 250);
}

function stopTicker() {
  if (ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function readInputDuration() {
  const hrs = Math.min(99, Math.max(0, parseInt(els.hoursInput.value, 10) || 0));
  const mins = Math.min(59, Math.max(0, parseInt(els.minutesInput.value, 10) || 0));
  const secs = Math.min(59, Math.max(0, parseInt(els.secondsInput.value, 10) || 0));
  return (hrs * 3600 + mins * 60 + secs) * 1000;
}

// ============================================================
//  STOPWATCH
// ============================================================

function swLive(state) {
  if (!state) return 0;
  if (state.status === "running" && state.startTime) {
    return Date.now() - state.startTime;
  }
  return Number.isFinite(state.elapsed) ? state.elapsed : 0;
}

function paintSwTime(ms) {
  const { main, cs } = formatSw(ms);
  els.swTime.innerHTML = `${main}<span class="sw-display__cs">.${cs}</span>`;
}

function renderLaps(laps) {
  // Only append new laps so existing ones keep their entrance animation.
  if (laps.length < swLapCount) {
    els.lapList.innerHTML = "";
    swLapCount = 0;
  }

  // Determine best/worst by split time.
  const splits = laps.map((t, i) => (i === 0 ? t : t - laps[i - 1]));
  let bestIdx = -1;
  let worstIdx = -1;
  if (splits.length > 1) {
    bestIdx = splits.indexOf(Math.min(...splits));
    worstIdx = splits.indexOf(Math.max(...splits));
  }

  for (let i = swLapCount; i < laps.length; i++) {
    const li = document.createElement("li");
    li.className = "lap";
    li.dataset.index = i;
    const split = i === 0 ? laps[0] : laps[i] - laps[i - 1];
    const { main, cs } = formatSw(split);
    li.innerHTML =
      `<span class="lap__index">Lap ${i + 1}</span>` +
      `<span class="lap__time">${main}.${cs}</span>`;
    els.lapList.prepend(li);
  }
  swLapCount = laps.length;

  // Refresh best/worst highlighting across all rendered laps.
  els.lapList.querySelectorAll(".lap").forEach((li) => {
    const idx = parseInt(li.dataset.index, 10);
    li.classList.toggle("is-best", idx === bestIdx && splits.length > 1);
    li.classList.toggle("is-worst", idx === worstIdx && splits.length > 1);
  });
}

// A value is a valid stopwatch state only if it carries stopwatch fields,
// guarding against empty storage or an unexpected (e.g. timer-shaped) object.
function isValidSwResponse(state) {
  return (
    state &&
    ["idle", "running", "paused"].includes(state.status) &&
    ("elapsed" in state || "laps" in state || "startTime" in state)
  );
}

function normalizeSw(state) {
  if (!isValidSwResponse(state)) {
    return { status: "idle", startTime: null, elapsed: 0, laps: [] };
  }
  return {
    status: state.status,
    startTime: state.startTime ?? null,
    elapsed: Number.isFinite(state.elapsed) ? state.elapsed : 0,
    laps: Array.isArray(state.laps) ? state.laps : [],
  };
}

// Local transitions mirror background.js so the UI responds instantly even if
// the worker is slow/asleep/stale. The worker remains source of truth for
// background persistence and we re-sync from its response when it's valid.
function localStart(s) {
  if (s.status === "running") return s;
  return { ...s, status: "running", startTime: Date.now() - (s.elapsed || 0) };
}

function localPause(s) {
  if (s.status !== "running") return s;
  return { ...s, status: "paused", elapsed: swLive(s), startTime: null };
}

function localLap(s) {
  if (s.status === "idle") return s;
  return { ...s, laps: [...(s.laps || []), swLive(s)] };
}

function localReset() {
  return { status: "idle", startTime: null, elapsed: 0, laps: [] };
}

function renderStopwatch(rawState) {
  const state = normalizeSw(rawState);
  swCached = state;
  const running = state.status === "running";

  paintSwTime(swLive(state));
  els.swDisplay.classList.toggle("is-running", running);

  renderLaps(state.laps || []);

  if (state.status === "idle") {
    els.swState.textContent = "Ready";
    els.swMainBtn.classList.remove("btn--ghost");
    els.swMainBtn.classList.add("btn--primary");
    els.swMainBtn.innerHTML = '<span class="btn__plus">▶</span> Start';
    els.swLapBtn.classList.add("hidden");
    els.swResetBtn.classList.add("hidden");
    els.swControls.classList.remove("two");
    stopSwTicker();
  } else if (running) {
    els.swState.textContent = "Running";
    els.swMainBtn.classList.remove("btn--primary");
    els.swMainBtn.classList.add("btn--ghost");
    els.swMainBtn.textContent = "Pause";
    els.swLapBtn.classList.remove("hidden");
    els.swLapBtn.textContent = "Lap";
    els.swResetBtn.classList.remove("hidden");
    els.swControls.classList.add("two");
    startSwTicker();
  } else {
    // paused
    els.swState.textContent = "Paused";
    els.swMainBtn.classList.remove("btn--ghost");
    els.swMainBtn.classList.add("btn--primary");
    els.swMainBtn.innerHTML = '<span class="btn__plus">▶</span> Resume';
    els.swLapBtn.classList.add("hidden");
    els.swResetBtn.classList.remove("hidden");
    els.swControls.classList.remove("two");
    stopSwTicker();
  }
}

function startSwTicker() {
  if (swTicker) return;
  swTicker = setInterval(() => {
    if (swCached) paintSwTime(swLive(swCached));
  }, 33);
}

function stopSwTicker() {
  if (swTicker) {
    clearInterval(swTicker);
    swTicker = null;
  }
}

// ============================================================
//  WHAT'S NEW
// ============================================================

const LAST_SEEN_VERSION_KEY = "lastSeenVersion";

const CHANGELOG = {
  "1.2.2": [
    "Pomodoro starts the next phase automatically",
    "Sites are blocked during focus, and free during breaks",
    "The block switch stays off until you choose a site",
  ],
  "1.2.0": [
    "Block distracting sites while your timer runs",
    "Add any site you want, or tap a built-in one",
    "Switch blocking off anytime without losing your list",
  ],
  "1.1.0": [
    "Pomodoro durations are now yours to set — tap any number to edit",
  ],
};

async function maybeShowWhatsNew() {
  const version = chrome.runtime.getManifest().version;
  const notes = CHANGELOG[version];
  if (!notes) return;

  let lastSeen;
  try {
    const data = await chrome.storage.local.get(LAST_SEEN_VERSION_KEY);
    lastSeen = data[LAST_SEEN_VERSION_KEY];
  } catch { return; }

  if (lastSeen === version) return;

  els.whatsNewVersion.textContent = `What's new in v${version}`;
  els.whatsNewList.innerHTML = notes
    .map((n) => `<li>${n}</li>`)
    .join("");
  els.whatsNew.classList.remove("hidden");
}

function dismissWhatsNew() {
  els.whatsNew.classList.add("hidden");
  chrome.storage.local
    .set({ [LAST_SEEN_VERSION_KEY]: chrome.runtime.getManifest().version })
    .catch(() => { });
}

// ============================================================
//  BLOCK LIST
// ============================================================

const BLOCK_KEY = "blockedSites";
const BLOCK_COLLAPSED_KEY = "blockCollapsed";
const BLOCK_CUSTOM_KEY = "blockCustomSites";
const BLOCK_ENABLED_KEY = "blockEnabled";

// Chips shipped with the extension. These can be toggled but never deleted.
const BUILT_IN_SITES = [
  { domain: "youtube.com", label: "🎬 YouTube", also: ["youtu.be"] },
  { domain: "facebook.com", label: "📘 Facebook" },
  { domain: "x.com", label: "🐦 X", also: ["twitter.com"] },
  { domain: "instagram.com", label: "📸 Instagram" },
  { domain: "tiktok.com", label: "🎵 TikTok" },
  { domain: "reddit.com", label: "📰 Reddit" },
  { domain: "netflix.com", label: "🎥 Netflix" },
  { domain: "twitch.tv", label: "🎮 Twitch" },
];

let blocks = [];        // domains currently blocked (drives the rules)
let customSites = [];   // user-added chips, kept even when toggled off
let blockEnabled = false;

async function blockRead() {
  try {
    const data = await chrome.storage.local.get(BLOCK_KEY);
    return Array.isArray(data[BLOCK_KEY]) ? data[BLOCK_KEY] : [];
  } catch { return []; }
}

async function blockCustomRead() {
  try {
    const data = await chrome.storage.local.get(BLOCK_CUSTOM_KEY);
    return Array.isArray(data[BLOCK_CUSTOM_KEY]) ? data[BLOCK_CUSTOM_KEY] : [];
  } catch { return []; }
}

async function blockEnabledRead() {
  try {
    const data = await chrome.storage.local.get([BLOCK_ENABLED_KEY, BLOCK_KEY]);
    // An explicit choice always wins. With no saved choice, stay off until the
    // user has actually selected a site. 1.2.0 left the switch on by default
    // even with an empty list, so a saved list and no saved switch still means on.
    if (typeof data[BLOCK_ENABLED_KEY] === "boolean") return data[BLOCK_ENABLED_KEY];
    const sites = Array.isArray(data[BLOCK_KEY]) ? data[BLOCK_KEY] : [];
    return sites.length > 0;
  } catch { return false; }
}

// Any change to the blocklist must reach a session that is already under way.
function pushBlockRules() {
  if (cached && (cached.status === "running" || cached.status === "paused")) {
    send({ type: "UPDATE_BLOCK_RULES" });
  }
}

function blockWrite() {
  chrome.storage.local.set({ [BLOCK_KEY]: blocks }).catch(() => { });
  pushBlockRules();
}

function blockCustomWrite() {
  chrome.storage.local.set({ [BLOCK_CUSTOM_KEY]: customSites }).catch(() => { });
}

function setBlockEnabled(enabled, persist = true) {
  blockEnabled = enabled;
  els.blockPower.setAttribute("aria-checked", String(enabled));
  const title = enabled ? "Turn blocking off" : "Turn blocking on";
  els.blockPower.title = title;
  els.blockPower.setAttribute("aria-label", title);
  els.blockWrap.classList.toggle("is-off", !enabled);
  syncBlockEmpty();
  if (persist) {
    chrome.storage.local.set({ [BLOCK_ENABLED_KEY]: enabled }).catch(() => { });
    pushBlockRules();
  }
}

function syncBlockEmpty() {
  const show = blockEnabled && blocks.length === 0;
  els.blockEmpty.classList.toggle("hidden", !show);
}

async function blockCollapsedRead() {
  try {
    const data = await chrome.storage.local.get(BLOCK_COLLAPSED_KEY);
    return !!data[BLOCK_COLLAPSED_KEY];
  } catch { return false; }
}

function setBlockCollapsed(collapsed, persist = true) {
  els.blockWrap.classList.toggle("hidden", collapsed);
  els.blockToggle.classList.toggle("is-collapsed", collapsed);
  const title = collapsed ? "Show block list" : "Hide block list";
  els.blockToggle.title = title;
  els.blockToggle.setAttribute("aria-label", title);
  if (persist) chrome.storage.local.set({ [BLOCK_COLLAPSED_KEY]: collapsed }).catch(() => { });
}

function normalizeDomain(input) {
  return input.trim().toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
}

function isValidDomain(domain) {
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z]{2,})+$/.test(domain);
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderBlockChips() {
  const chips = [
    ...BUILT_IN_SITES.map((s) => ({ ...s, custom: false })),
    ...customSites.map((d) => ({ domain: d, label: d, custom: true })),
  ];

  els.blockPresets.innerHTML = chips
    .map(({ domain, label, custom, also }) => {
      const on = blocks.includes(domain);
      const safe = escapeHtml(domain);
      const remove = custom
        ? `<span class="block-preset__remove" data-remove="${safe}" title="Remove ${safe}">&times;</span>`
        : "";
      const covered = [domain, ...(also || [])].join(", ");
      const title = also && also.length
        ? `${on ? "Blocked" : "Not blocked"} — click to toggle (${covered})`
        : `${on ? "Blocked" : "Not blocked"} — click to toggle`;
      return (
        `<button class="block-preset${on ? " is-added" : ""}" data-domain="${safe}"` +
        ` title="${escapeHtml(title)}">` +
        `${escapeHtml(label)}${remove}</button>`
      );
    })
    .join("");
  syncBlockEmpty();
}

function toggleBlock(domain) {
  const idx = blocks.indexOf(domain);
  if (idx > -1) blocks.splice(idx, 1);
  else blocks.push(domain);
  blockWrite();
  renderBlockChips();
}

function removeCustomSite(domain) {
  customSites = customSites.filter((d) => d !== domain);
  blocks = blocks.filter((d) => d !== domain);
  blockCustomWrite();
  blockWrite();
  renderBlockChips();
}

function addBlock(raw) {
  const domain = normalizeDomain(raw);
  if (!domain) return;
  if (!isValidDomain(domain)) {
    els.blockInput.classList.add("invalid");
    return;
  }
  els.blockInput.classList.remove("invalid");

  const isBuiltIn = BUILT_IN_SITES.some((s) => s.domain === domain);
  if (!isBuiltIn && !customSites.includes(domain)) {
    customSites.push(domain);
    blockCustomWrite();
  }
  if (!blocks.includes(domain)) {
    blocks.push(domain);
    blockWrite();
  }
  renderBlockChips();
  els.blockInput.value = "";
}

// ============================================================
//  WORLD CLOCK
// ============================================================

const TZ_KEY = "timezones";
const TZ_COLLAPSED_KEY = "tzCollapsed";
let zones = []; // array of IANA time-zone strings
let tzTicker = null;

async function tzCollapsedRead() {
  try {
    const data = await chrome.storage.local.get(TZ_COLLAPSED_KEY);
    // No saved choice means collapsed, so blocking sits above the fold.
    // A stored true/false is the user's own toggle and is left alone.
    if (typeof data[TZ_COLLAPSED_KEY] === "boolean") return data[TZ_COLLAPSED_KEY];
    return true;
  } catch {
    return true;
  }
}

function setTzCollapsed(collapsed, persist = true) {
  els.tzInputWrap.classList.toggle("hidden", collapsed);
  els.tzToggle.classList.toggle("is-collapsed", collapsed);
  const title = collapsed ? "Show add field" : "Hide add field";
  els.tzToggle.title = title;
  els.tzToggle.setAttribute("aria-label", title);
  if (persist) {
    chrome.storage.local.set({ [TZ_COLLAPSED_KEY]: collapsed }).catch(() => { });
  }
}

async function tzRead() {
  try {
    const data = await chrome.storage.local.get(TZ_KEY);
    return Array.isArray(data[TZ_KEY]) ? data[TZ_KEY] : [];
  } catch {
    return [];
  }
}

function tzWrite() {
  chrome.storage.local.set({ [TZ_KEY]: zones }).catch(() => { });
}

function isValidZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function zoneCity(zone) {
  const parts = zone.split("/");
  return parts[parts.length - 1].replace(/_/g, " ");
}

function zoneTime(zone) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date());
  } catch {
    return "--:--:--";
  }
}

function renderClocks() {
  els.tzClocks.innerHTML = "";
  zones.forEach((zone) => {
    const li = document.createElement("li");
    li.className = "tz-clock";
    li.innerHTML =
      `<div class="tz-clock__info">` +
      `<span class="tz-clock__city">${zoneCity(zone)}</span>` +
      `<span class="tz-clock__zone">${zone}</span>` +
      `</div>` +
      `<span class="tz-clock__time">${zoneTime(zone)}</span>` +
      `<button class="tz-clock__remove" title="Remove" aria-label="Remove">&times;</button>`;
    els.tzClocks.appendChild(li);
  });

  if (zones.length > 0) startTzTicker();
  else stopTzTicker();
}

function updateClockTimes() {
  const items = els.tzClocks.querySelectorAll(".tz-clock");
  items.forEach((li, i) => {
    const zone = zones[i];
    const t = li.querySelector(".tz-clock__time");
    if (zone && t) t.textContent = zoneTime(zone);
  });
}

function startTzTicker() {
  if (tzTicker) return;
  tzTicker = setInterval(updateClockTimes, 1000);
}

function stopTzTicker() {
  if (tzTicker) {
    clearInterval(tzTicker);
    tzTicker = null;
  }
}

function addZone(raw) {
  const zone = (raw || "").trim();
  if (!zone) return;
  if (!isValidZone(zone)) {
    els.tzInput.classList.add("invalid");
    return;
  }
  els.tzInput.classList.remove("invalid");
  if (!zones.includes(zone)) {
    zones.push(zone);
    tzWrite();
    renderClocks();
  }
  els.tzInput.value = "";
}

// ============================================================
//  TABS
// ============================================================

const MODES = ["timer", "stopwatch"];

function setMode(mode, persist = true) {
  if (!MODES.includes(mode)) mode = "timer";
  els.tabTimer.classList.toggle("is-active", mode === "timer");
  els.tabStopwatch.classList.toggle("is-active", mode === "stopwatch");
  els.tabTimer.setAttribute("aria-selected", mode === "timer" ? "true" : "false");
  els.tabStopwatch.setAttribute("aria-selected", mode === "stopwatch" ? "true" : "false");
  els.tabTimer.tabIndex = mode === "timer" ? 0 : -1;
  els.tabStopwatch.tabIndex = mode === "stopwatch" ? 0 : -1;

  const idx = MODES.indexOf(mode);
  els.tabIndicator.style.transform = `translateX(${idx * 100}%)`;

  els.timerMode.classList.toggle("hidden", mode !== "timer");
  els.stopwatchMode.classList.toggle("hidden", mode !== "stopwatch");

  // restart entrance animation on the shown mode
  const shown = mode === "timer" ? els.timerMode : els.stopwatchMode;
  shown.style.animation = "none";
  void shown.offsetWidth;
  shown.style.animation = "";

  if (persist) modeWrite(mode);
}

// ---------- Sub-mode: standard vs pomodoro ----------

const SUB_MODES = ["standard", "pomodoro"];

async function subModeRead() {
  try {
    const data = await chrome.storage.local.get(SUB_MODE_KEY);
    return SUB_MODES.includes(data[SUB_MODE_KEY]) ? data[SUB_MODE_KEY] : "standard";
  } catch {
    return "standard";
  }
}

function setSubMode(sub, persist = true) {
  if (!SUB_MODES.includes(sub)) sub = "standard";
  timerSubMode = sub;
  els.subStandard.classList.toggle("is-active", sub === "standard");
  els.subPomodoro.classList.toggle("is-active", sub === "pomodoro");
  els.subStandard.setAttribute("aria-selected", sub === "standard" ? "true" : "false");
  els.subPomodoro.setAttribute("aria-selected", sub === "pomodoro" ? "true" : "false");
  els.subStandard.tabIndex = sub === "standard" ? 0 : -1;
  els.subPomodoro.tabIndex = sub === "pomodoro" ? 0 : -1;
  const idx = SUB_MODES.indexOf(sub);
  els.subIndicator.style.transform = `translateX(${idx * 100}%)`;

  // Only swap setup views if currently in idle/setup
  if (!cached || cached.status === "idle") {
    els.setupView.classList.toggle("hidden", sub !== "standard");
    els.pomoSetup.classList.toggle("hidden", sub !== "pomodoro");
  }

  if (persist) chrome.storage.local.set({ [SUB_MODE_KEY]: sub }).catch(() => { });
}

// ============================================================
//  EVENTS
// ============================================================

els.startBtn.addEventListener("click", async () => {
  const durationMs = readInputDuration();
  if (durationMs <= 0) {
    els.minutesInput.focus();
    return;
  }
  const label = els.focusMsgInput.value.trim();
  labelWrite(label);
  render(await send({ type: "START", durationMs, label }));
});

els.presets.forEach((btn) => {
  btn.addEventListener("click", async () => {
    const mins = parseInt(btn.dataset.minutes, 10) || 0;
    const label = els.focusMsgInput.value.trim();
    labelWrite(label);
    render(await send({ type: "START", durationMs: mins * 60 * 1000, label }));
  });
});

els.pauseBtn.addEventListener("click", async () => {
  if (!cached) return;
  const type = cached.status === "paused" ? "RESUME" : "PAUSE";
  render(await send({ type }));
});

els.resetBtn.addEventListener("click", async () => {
  labelWrite("");
  render(await send({ type: "RESET" }));
});

// Pomodoro: Start Focus
function pomoSession(phase, cycle) {
  return {
    phase,
    cycle,
    focusMs: pomoCustom.focus * 60 * 1000,
    breakMs: pomoCustom.break * 60 * 1000,
    longBreakMs: pomoCustom.longBreak * 60 * 1000,
  };
}

els.pomoStartBtn.addEventListener("click", async () => {
  const pomodoro = pomoSession("focus", 1);
  render(await send({ type: "START", durationMs: pomodoro.focusMs, label: "", pomodoro }));
});

// Pomodoro: Skip current phase
els.skipBtn.addEventListener("click", async () => {
  render(await send({ type: "SKIP_PHASE" }));
});

// Pomodoro: Start next phase
els.pomoNextBtn.addEventListener("click", async () => {
  if (!cached || !cached.pomodoro) return;
  const pomo = cached.pomodoro;
  const nextPhase = pomo.nextPhase || "focus";
  const nextPomo = pomo.focusMs
    ? { ...pomo, phase: nextPhase }
    : pomoSession(nextPhase, pomo.cycle);
  render(await send({
    type: "START",
    durationMs: phaseLengthFrom(nextPomo),
    label: "",
    pomodoro: nextPomo,
  }));
});

function phaseLengthFrom(pomo) {
  if (pomo.phase === "break") return pomo.breakMs;
  if (pomo.phase === "longBreak") return pomo.longBreakMs;
  return pomo.focusMs;
}

// Sub-mode tabs
els.subStandard.addEventListener("click", () => setSubMode("standard"));
els.subPomodoro.addEventListener("click", () => setSubMode("pomodoro"));

// Custom Pomodoro durations
function onPomoInputChange(key, input, min, max, fallback) {
  let v = clampPomoMin(input.value, min, max, fallback);
  input.value = v;
  pomoCustom[key] = v;
  pomoCustomWrite();
}
els.pomoFocusInput.addEventListener("change", () => onPomoInputChange("focus",     els.pomoFocusInput, 1, 99, POMO_FOCUS_DEFAULT));
els.pomoBreakInput.addEventListener("change", () => onPomoInputChange("break",     els.pomoBreakInput, 1, 59, POMO_BREAK_DEFAULT));
els.pomoLongInput.addEventListener ("change", () => onPomoInputChange("longBreak", els.pomoLongInput,  1, 99, POMO_LONG_DEFAULT));

function clampPad(input, max) {
  let v = parseInt(input.value, 10) || 0;
  v = Math.min(max, Math.max(0, v));
  input.value = String(v).padStart(2, "0");
}

els.hoursInput.addEventListener("blur", () => clampPad(els.hoursInput, 99));
els.minutesInput.addEventListener("blur", () => clampPad(els.minutesInput, 59));
els.secondsInput.addEventListener("blur", () => clampPad(els.secondsInput, 59));

els.focusMsgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.startBtn.click();
});

// Each handler computes the next state locally, renders it instantly, and
// persists it to storage so it survives the popup closing.
function applySw(next) {
  renderStopwatch(next);
  swWrite(next);
}

els.swMainBtn.addEventListener("click", () => {
  const cur = swCached || localReset();
  applySw(cur.status === "running" ? localPause(cur) : localStart(cur));
});

els.swLapBtn.addEventListener("click", () => {
  applySw(localLap(swCached || localReset()));
});

els.swResetBtn.addEventListener("click", () => {
  swLapCount = 0;
  els.lapList.innerHTML = "";
  applySw(localReset());
});

els.tabTimer.addEventListener("click", () => setMode("timer"));
els.tabStopwatch.addEventListener("click", () => setMode("stopwatch"));

function wireTabKeys(tabs) {
  tabs.forEach((tab, index) => {
    tab.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      event.preventDefault();
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(index + delta + tabs.length) % tabs.length];
      next.focus();
      next.click();
    });
  });
}

wireTabKeys([els.tabTimer, els.tabStopwatch]);
wireTabKeys([els.subStandard, els.subPomodoro]);

els.tzToggle.addEventListener("click", () => {
  const collapsed = !els.tzToggle.classList.contains("is-collapsed");
  setTzCollapsed(collapsed);
});

// Block list events
els.blockToggle.addEventListener("click", () => {
  const collapsed = !els.blockToggle.classList.contains("is-collapsed");
  setBlockCollapsed(collapsed);
});

els.blockAddBtn.addEventListener("click", () => addBlock(els.blockInput.value));

els.blockInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addBlock(els.blockInput.value);
});

els.blockInput.addEventListener("input", () => {
  els.blockInput.classList.remove("invalid");
});

els.whatsNewClose.addEventListener("click", dismissWhatsNew);

els.blockPower.addEventListener("click", () => setBlockEnabled(!blockEnabled));

// Chips are re-rendered on every change, so delegate instead of re-binding.
els.blockPresets.addEventListener("click", (e) => {
  const remove = e.target.closest(".block-preset__remove");
  if (remove) {
    removeCustomSite(remove.dataset.remove);
    return;
  }
  const chip = e.target.closest(".block-preset");
  if (chip) toggleBlock(chip.dataset.domain);
});

els.tzAddBtn.addEventListener("click", () => addZone(els.tzInput.value));

els.tzInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addZone(els.tzInput.value);
});

els.tzInput.addEventListener("input", () => {
  els.tzInput.classList.remove("invalid");
});

els.tzClocks.addEventListener("click", (e) => {
  const btn = e.target.closest(".tz-clock__remove");
  if (!btn) return;
  const li = btn.closest(".tz-clock");
  const idx = Array.prototype.indexOf.call(els.tzClocks.children, li);
  if (idx > -1) {
    zones.splice(idx, 1);
    tzWrite();
    renderClocks();
  }
});

// ============================================================
//  INIT
// ============================================================

(async () => {
  const [timerState, swState, mode, savedZones, tzCollapsed, savedLabel, savedSubMode, savedPomoCustom, savedBlocks, blockCollapsed, savedCustomSites, savedBlockEnabled] =
    await Promise.all([
      send({ type: "GET_STATE" }),
      swRead(),
      modeRead(),
      tzRead(),
      tzCollapsedRead(),
      labelRead(),
      subModeRead(),
      pomoCustomRead(),
      blockRead(),
      blockCollapsedRead(),
      blockCustomRead(),
      blockEnabledRead(),
    ]);

  pomoCustom = savedPomoCustom;
  syncPomoInputs();

  focusLabel = savedLabel;
  if (savedLabel) {
    els.focusMsgInput.value = savedLabel;
  }

  // If a pomodoro session is active, force sub-mode to pomodoro
  const activeState = timerState || { status: "idle", remaining: 0, totalDuration: 0 };
  if (activeState.pomodoro) {
    setSubMode("pomodoro", false);
  } else {
    setSubMode(savedSubMode, false);
  }

  render(activeState);
  renderStopwatch(swState);
  setMode(mode, false);
  zones = savedZones;
  renderClocks();
  setTzCollapsed(tzCollapsed, false);
  blocks = savedBlocks;
  customSites = savedCustomSites;
  renderBlockChips();
  setBlockCollapsed(blockCollapsed, false);
  setBlockEnabled(savedBlockEnabled, false);
  if (cached) syncPauseBlockNote(cached);
  maybeShowWhatsNew();
})();
