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

// Pomodoro constants (mirror background.js)
const POMO_FOCUS_MS = 25 * 60 * 1000;
const POMO_BREAK_MS = 5 * 60 * 1000;
const POMO_LONG_BREAK_MS = 15 * 60 * 1000;
const POMO_TOTAL_CYCLES = 4;

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

  // ---------- Done / running / paused ----------
  if (state.status === "done") {
    els.stateLabel.classList.add("is-done");
    els.stateLabel.classList.remove("has-label");
    els.pauseBtn.classList.add("hidden");
    els.skipBtn.classList.add("hidden");

    if (pomo && pomo.nextPhase) {
      els.stateLabel.textContent = phaseLabel(pomo.phase) + " Done";
      els.pomoNextBtn.classList.remove("hidden");
      const nextLabel = phaseLabel(pomo.nextPhase);
      els.pomoNextBtn.innerHTML = `<span class="btn__plus">\u25b6</span> Start ${nextLabel}`;
      els.resetBtn.textContent = "End";
      // Update controls grid for 1 button (reset only, next is outside)
      els.controls.classList.remove("three");
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
}

function phaseLabel(phase) {
  if (phase === "focus") return "Focus";
  if (phase === "break") return "Break";
  return "Long Break";
}

function phaseDurationMs(phase) {
  if (phase === "focus") return POMO_FOCUS_MS;
  if (phase === "break") return POMO_BREAK_MS;
  return POMO_LONG_BREAK_MS;
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
//  WORLD CLOCK
// ============================================================

const TZ_KEY = "timezones";
const TZ_COLLAPSED_KEY = "tzCollapsed";
let zones = []; // array of IANA time-zone strings
let tzTicker = null;

async function tzCollapsedRead() {
  try {
    const data = await chrome.storage.local.get(TZ_COLLAPSED_KEY);
    return !!data[TZ_COLLAPSED_KEY];
  } catch {
    return false;
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
els.pomoStartBtn.addEventListener("click", async () => {
  const pomodoro = { phase: "focus", cycle: 1 };
  render(await send({ type: "START", durationMs: POMO_FOCUS_MS, label: "", pomodoro }));
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
  const durationMs = phaseDurationMs(nextPhase);
  const nextPomo = { phase: nextPhase, cycle: pomo.cycle };
  render(await send({ type: "START", durationMs, label: "", pomodoro: nextPomo }));
});

// Sub-mode tabs
els.subStandard.addEventListener("click", () => setSubMode("standard"));
els.subPomodoro.addEventListener("click", () => setSubMode("pomodoro"));

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

els.tzToggle.addEventListener("click", () => {
  const collapsed = !els.tzToggle.classList.contains("is-collapsed");
  setTzCollapsed(collapsed);
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
  const [timerState, swState, mode, savedZones, tzCollapsed, savedLabel, savedSubMode] =
    await Promise.all([
      send({ type: "GET_STATE" }),
      swRead(),
      modeRead(),
      tzRead(),
      tzCollapsedRead(),
      labelRead(),
      subModeRead(),
    ]);

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
})();
