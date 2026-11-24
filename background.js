// Focus Timer — MV3 service worker.
// Owns all timer state so the countdown stays accurate even when the popup is
// closed or the worker is suspended. State is persisted to chrome.storage and
// the finish moment is driven by a chrome.alarms alarm (survives suspension).
//
// IMPORTANT: Every async path in an event handler must be returned/awaited so
// the service worker stays alive until the work (notification, sound) finishes.

const ALARM_NAME = "focus-timer-finish";
const WATCHDOG_ALARM = "focus-timer-watchdog";
const STORAGE_KEY = "timerState";
const MODE_KEY = "activeMode";
const LEGACY_POMO_ALARM = "pomodoro-finish";
const LEGACY_POMO_KEY = "pomodoroState";
const BLOCKED_SITES_KEY = "blockedSites";
const BLOCK_ENABLED_KEY = "blockEnabled";

// In-memory fallback timer for short durations where chrome.alarms clamps the
// delay to ~30 s.  Cleared on pause / reset so it never fires stale.
let shortTimerTimeout = null;

// ---------- Site Blocking (declarativeNetRequest) ----------

async function getBlockedSites() {
  try {
    const data = await chrome.storage.local.get([BLOCKED_SITES_KEY, BLOCK_ENABLED_KEY]);
    if (data[BLOCK_ENABLED_KEY] === false) return [];
    return Array.isArray(data[BLOCKED_SITES_KEY]) ? data[BLOCKED_SITES_KEY] : [];
  } catch {
    return [];
  }
}

async function setBlockRules(sites) {
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing.map((r) => r.id);
    if (sites.length === 0) {
      if (removeIds.length > 0) {
        await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds });
      }
      return;
    }
    // "block" needs no host permission, so it can never be skipped because of
    // the user's per-extension site-access setting (unlike "redirect").
    const addRules = sites.map((domain, i) => ({
      id: i + 1,
      priority: 1,
      action: { type: "block" },
      condition: { urlFilter: `||${domain}^`, resourceTypes: ["main_frame"] },
    }));
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds, addRules });
  } catch (err) {
    console.warn("Focus Timer: setBlockRules failed", err);
  }
}

// Second layer: swap the browser's generic error page for our own blocked page.
// Uses the tabs API (no host permission needed) so it works regardless of the
// user's site-access setting.
function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

async function maybeBlockTab(tabId, url) {
  if (!url || !/^https?:/i.test(url)) return;

  const host = hostOf(url);
  if (!host) return;

  // Runs on every navigation, so keep it to a single storage read.
  const data = await chrome.storage.local.get([
    STORAGE_KEY,
    BLOCKED_SITES_KEY,
    BLOCK_ENABLED_KEY,
  ]);
  if (!blocksApply(data[STORAGE_KEY] || {})) return;
  if (data[BLOCK_ENABLED_KEY] === false) return;

  const sites = Array.isArray(data[BLOCKED_SITES_KEY]) ? data[BLOCKED_SITES_KEY] : [];
  if (sites.length === 0) return;

  const blocked = sites.some((d) => host === d || host.endsWith(`.${d}`));
  if (!blocked) return;

  try {
    const target = chrome.runtime.getURL("blocked.html") + `?site=${encodeURIComponent(host)}`;
    await chrome.tabs.update(tabId, { url: target });
  } catch (err) {
    console.warn("Focus Timer: tab redirect failed", err);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const url = changeInfo.url || (changeInfo.status === "loading" ? tab.url : null);
  if (url) return maybeBlockTab(tabId, url);
});

async function clearBlockRules() {
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing.map((r) => r.id);
    if (removeIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: removeIds });
    }
  } catch (err) {
    console.warn("Focus Timer: clearBlockRules failed", err);
  }
}

// Blocking is a focus-session behavior. Standard timers count as focus.
// Pomodoro breaks and long breaks do not. Pausing a focus phase keeps the
// rules in place; pausing does not call this helper.
function blocksApply(state) {
  if (!state || (state.status !== "running" && state.status !== "paused")) return false;
  if (state.pomodoro && state.pomodoro.phase !== "focus") return false;
  return true;
}

async function applyBlockingForState(state) {
  if (blocksApply(state)) {
    await setBlockRules(await getBlockedSites());
  } else {
    await clearBlockRules();
  }
}

function phaseLengthMs(pomo) {
  const pick = (value, fallback) =>
    Number.isFinite(value) && value > 0 ? value : fallback;
  if (pomo && pomo.phase === "break") return pick(pomo.breakMs, POMO_BREAK_MS);
  if (pomo && pomo.phase === "longBreak") return pick(pomo.longBreakMs, POMO_LONG_BREAK_MS);
  return pick(pomo && pomo.focusMs, POMO_FOCUS_MS);
}

// Pomodoro fixed durations (ms)
const POMO_FOCUS_MS = 25 * 60 * 1000;
const POMO_BREAK_MS = 5 * 60 * 1000;
const POMO_LONG_BREAK_MS = 15 * 60 * 1000;
const POMO_TOTAL_CYCLES = 4;

// Shape of the persisted state:
// {
//   status: "idle" | "running" | "paused" | "done",
//   endTime: number | null,      // epoch ms when running
//   remaining: number,           // ms left (authoritative while paused/idle)
//   totalDuration: number        // ms of the full session (for the ring)
// }
const DEFAULT_STATE = {
  status: "idle",
  endTime: null,
  remaining: 0,
  totalDuration: 0,
  label: "",
  pomodoro: null, // { phase, cycle, nextPhase } when active
};

async function getState() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  return { ...DEFAULT_STATE, ...(data[STORAGE_KEY] || {}) };
}

async function setState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  return state;
}

// Remaining ms computed live from the absolute end time when running.
function liveRemaining(state) {
  if (state.status === "running" && state.endTime) {
    return Math.max(0, state.endTime - Date.now());
  }
  return state.remaining;
}

function publicState(state) {
  return { ...state, remaining: liveRemaining(state) };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateBadge(state) {
  const remaining = liveRemaining(state);
  if (state.status === "running" && remaining > 0) {
    const totalSec = Math.round(remaining / 1000);
    const mins = Math.floor(totalSec / 60);
    const text = mins >= 1 ? `${mins}m` : `${totalSec}s`;
    await chrome.action.setBadgeBackgroundColor({ color: "#7c3aed" });
    await chrome.action.setBadgeText({ text });
  } else if (state.status === "paused") {
    await chrome.action.setBadgeBackgroundColor({ color: "#8a829e" });
    await chrome.action.setBadgeText({ text: "II" });
  } else {
    await chrome.action.setBadgeText({ text: "" });
  }
}

// ---------- Commands ----------

async function startTimer(durationMs, label = "", pomodoro = null) {
  // Clear any leftover short-timer fallback from a previous session.
  clearShortTimer();

  const now = Date.now();
  const state = {
    status: "running",
    endTime: now + durationMs,
    remaining: durationMs,
    totalDuration: durationMs,
    label: (label || "").toString().slice(0, 120),
    pomodoro: pomodoro || null,
  };
  await setState(state);

  // chrome.alarms silently clamps durations shorter than ~30 s (dev) / 1 min
  // (production).  For short timers, schedule a setTimeout as the primary
  // trigger — the alarm and watchdog remain as safety-nets.
  if (durationMs < 62000) {
    shortTimerTimeout = setTimeout(() => {
      shortTimerTimeout = null;
      finishTimer();
    }, durationMs);
  }

  chrome.alarms.create(ALARM_NAME, { when: state.endTime });
  // Watchdog: periodic safety-net alarm that catches missed finish events.
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.25 }); // ~15s
  await updateBadge(state);
  // Pre-create the offscreen document so sound is ready when the timer ends.
  ensureOffscreen();
  // Focus phases (and a plain timer) block. Breaks lift the rules.
  await applyBlockingForState(state);
  return publicState(state);
}

async function pauseTimer() {
  clearShortTimer();
  const state = await getState();
  if (state.status !== "running") return publicState(state);
  const remaining = liveRemaining(state);
  const next = { ...state, status: "paused", remaining, endTime: null };
  await setState(next);
  chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.clear(WATCHDOG_ALARM);
  await updateBadge(next);
  return publicState(next);
}

async function resumeTimer() {
  clearShortTimer();
  const state = await getState();
  if (state.status !== "paused" || state.remaining <= 0) {
    return publicState(state);
  }
  const next = {
    ...state,
    status: "running",
    endTime: Date.now() + state.remaining,
  };
  await setState(next);

  if (next.remaining < 62000) {
    shortTimerTimeout = setTimeout(() => {
      shortTimerTimeout = null;
      finishTimer();
    }, next.remaining);
  }

  chrome.alarms.create(ALARM_NAME, { when: next.endTime });
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.25 });
  await updateBadge(next);
  ensureOffscreen();
  // Pick up any blocklist edits made while the timer was paused.
  // A paused break stays unblocked; a paused focus phase blocks again.
  await applyBlockingForState(next);
  return publicState(next);
}

async function resetTimer() {
  clearShortTimer();
  chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.clear(WATCHDOG_ALARM);
  const next = { ...DEFAULT_STATE };
  await setState(next);
  await updateBadge(next);
  await clearBlockRules();
  return publicState(next);
}

// Holds only while a phase change is being written. Released before the
// notification so a short next phase can still finish on time.
let finishing = false;

function carryPomoLengths(from, phase, cycle) {
  return {
    phase,
    cycle,
    focusMs: from.focusMs,
    breakMs: from.breakMs,
    longBreakMs: from.longBreakMs,
  };
}

async function finishTimer(isSkip = false) {
  if (finishing) {
    while (finishing) await sleep(15);
    return publicState(await getState());
  }
  finishing = true;

  let doneMessage = "";
  let notifTitle = "Focus Timer";
  let result;
  try {
    const state = await getState();
    if (state.status !== "running") return publicState(state);
    if (!isSkip && liveRemaining(state) > 250) return publicState(state);

    clearShortTimer();
    chrome.alarms.clear(ALARM_NAME);
    chrome.alarms.clear(WATCHDOG_ALARM);

    if (state.pomodoro) {
      notifTitle = "Pomodoro Timer";
      const pomo = state.pomodoro;
      let nextPomo;
      if (pomo.phase === "focus") {
        nextPomo = carryPomoLengths(
          pomo,
          pomo.cycle >= POMO_TOTAL_CYCLES ? "longBreak" : "break",
          pomo.cycle,
        );
        doneMessage = isSkip
          ? `Focus ${pomo.cycle}/${POMO_TOTAL_CYCLES} skipped.`
          : `Focus ${pomo.cycle}/${POMO_TOTAL_CYCLES} complete! Time for a break.`;
      } else if (pomo.phase === "break") {
        nextPomo = carryPomoLengths(
          pomo,
          "focus",
          Math.min(pomo.cycle + 1, POMO_TOTAL_CYCLES),
        );
        doneMessage = isSkip ? "Break skipped!" : "Break over! Ready to focus?";
      } else {
        nextPomo = carryPomoLengths(pomo, "focus", 1);
        doneMessage = isSkip ? "Long break skipped!" : "Long break over! Fresh start.";
      }
      // Start the next phase immediately. startTimer blocks only on focus.
      result = await startTimer(phaseLengthMs(nextPomo), "", nextPomo);
    } else {
      doneMessage = state.label
        ? `Time's up! "${state.label}" — session complete.`
        : "Time's up! Your focus session is complete.";
      const next = { ...state, status: "done", endTime: null, remaining: 0 };
      await setState(next);
      await updateBadge(next);
      await clearBlockRules();
      result = publicState(next);
    }
  } finally {
    finishing = false;
  }

  try {
    await chrome.notifications.create(`focus-timer-done-${Date.now()}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: notifTitle,
      message: doneMessage,
      priority: 2,
    });
  } catch (err) {
    console.warn("Focus Timer: notification create failed", err);
  }

  try {
    await playSound();
  } catch (err) {
    console.warn("Focus Timer: chime failed", err);
  }

  return result;
}

// ---------- Sound via offscreen document ----------

async function hasOffscreen() {
  if (chrome.offscreen && chrome.offscreen.hasDocument) {
    return chrome.offscreen.hasDocument();
  }
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  return contexts.length > 0;
}

// Proactively create the offscreen document so it's ready when needed.
async function ensureOffscreen() {
  try {
    if (!(await hasOffscreen())) {
      await chrome.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Play a chime when the focus countdown reaches zero.",
      });
    }
  } catch (err) {
    console.warn("Focus Timer: offscreen setup failed", err);
  }
}

async function playSound() {
  try {
    await ensureOffscreen();
    await sendOffscreenSound();
  } catch (err) {
    // Offscreen may be unavailable; the notification still fires.
    console.warn("Focus Timer: sound playback failed", err);
  }
}

async function sendOffscreenSound() {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "PLAY_SOUND",
      });
      if (!response || response.ok !== false) return;
      lastError = new Error(response.error || "Offscreen sound failed.");
    } catch (err) {
      lastError = err;
    }
    await sleep(150);
  }
  throw lastError;
}

function clearShortTimer() {
  if (shortTimerTimeout !== null) {
    clearTimeout(shortTimerTimeout);
    shortTimerTimeout = null;
  }
}

async function cleanupLegacyPomodoro() {
  await chrome.alarms.clear(LEGACY_POMO_ALARM);
  const data = await chrome.storage.local.get([LEGACY_POMO_KEY, MODE_KEY]);
  if (data[LEGACY_POMO_KEY] !== undefined) {
    await chrome.storage.local.remove(LEGACY_POMO_KEY);
  }
  if (data[MODE_KEY] === "pomodoro") {
    await chrome.storage.local.set({ [MODE_KEY]: "timer" });
  }
}

// ---------- Event wiring ----------

// CRITICAL: The handler returns the promise so the MV3 service worker stays
// alive until finishTimer() (which awaits notification + sound) completes.
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) {
    return finishTimer();
  } else if (alarm.name === WATCHDOG_ALARM) {
    // Safety-net: if the finish alarm was missed, catch it here.
    return getState().then((state) => {
      if (state.status === "running" && liveRemaining(state) <= 0) {
        return finishTimer();
      } else if (state.status !== "running") {
        // Timer is no longer active; clean up the watchdog.
        chrome.alarms.clear(WATCHDOG_ALARM);
      }
    });
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target === "offscreen") return false;

  (async () => {
    switch (msg.type) {
      case "GET_STATE": {
        // Finalize on read if it's overdue, so a short timer ends promptly when
        // the popup is open even if the alarm is briefly delayed.
        const s = await getState();
        if (s.status === "running" && liveRemaining(s) <= 0) {
          sendResponse(await finishTimer());
        } else {
          sendResponse(publicState(s));
        }
        break;
      }
      case "START":
        sendResponse(await startTimer(msg.durationMs, msg.label, msg.pomodoro));
        break;
      case "PAUSE":
        sendResponse(await pauseTimer());
        break;
      case "RESUME":
        sendResponse(await resumeTimer());
        break;
      case "SKIP_PHASE":
        sendResponse(await finishTimer(true));
        break;
      case "RESET":
        sendResponse(await resetTimer());
        break;
      case "UPDATE_BLOCK_RULES": {
        await applyBlockingForState(await getState());
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse(publicState(await getState()));
    }
  })();

  return true; // keep the channel open for the async response
});

// Reconcile state on worker startup (e.g. after suspension/restart).
chrome.runtime.onStartup.addListener(reconcile);
chrome.runtime.onInstalled.addListener(reconcile);

// The popup shows a changelog whenever the stored version trails the running
// one. Stamping it on a fresh install keeps first-time users from seeing it.
chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason !== "install") return;
  return chrome.storage.local.set({
    lastSeenVersion: chrome.runtime.getManifest().version,
  });
});

async function reconcile() {
  await cleanupLegacyPomodoro();

  const state = await getState();
  if (state.status === "running") {
    const remaining = liveRemaining(state);
    if (remaining <= 0) {
      await finishTimer();
    } else {
      // Re-arm the short-timer fallback if applicable.
      if (remaining < 62000) {
        clearShortTimer();
        shortTimerTimeout = setTimeout(() => {
          shortTimerTimeout = null;
          finishTimer();
        }, remaining);
      }
      chrome.alarms.create(ALARM_NAME, { when: state.endTime });
      chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.25 });
      await updateBadge(state);
      ensureOffscreen();
      // Re-apply block rules in case the service worker was restarted.
      await applyBlockingForState(state);
    }
  } else {
    await updateBadge(state);
    // Paused focus stays blocked. Anything else (done, idle, a paused break)
    // must not leave rules behind — they outlive the worker.
    await applyBlockingForState(state);
  }
}

reconcile().catch((err) => {
  console.warn("Focus Timer: startup reconcile failed", err);
});
