// Logic for the "site blocked" page. Must live in its own file — MV3's content
// security policy refuses to run inline scripts on extension pages.

const QUOTES = [
  "Deep work is the ability to focus without distraction on a cognitively demanding task.",
  "The secret of getting ahead is getting started.",
  "Focus on being productive instead of busy.",
  "One task at a time. Do it well. Move on.",
  "You don't have to be great to start, but you have to start to be great.",
  "The successful warrior is the average person, with laser-like focus.",
];

document.getElementById("quote").textContent =
  `"${QUOTES[Math.floor(Math.random() * QUOTES.length)]}"`;

const site = new URLSearchParams(location.search).get("site");
if (site) {
  document.getElementById("siteName").textContent = site;
  document.getElementById("siteChip").classList.add("is-visible");
  document.title = `${site} is blocked — Focus Mode`;
}

async function closeTab() {
  try {
    const tab = await chrome.tabs.getCurrent();
    if (tab) {
      await chrome.tabs.remove(tab.id);
      return;
    }
  } catch { /* fall through to window.close() */ }
  window.close();
}

document.getElementById("closeBtn").addEventListener("click", closeTab);

// history.back() lands on the blocked site again, so step back past it.
// With no earlier entry to return to, closing the tab is the useful action.
document.getElementById("backBtn").addEventListener("click", () => {
  if (history.length > 2) history.go(-2);
  else if (history.length > 1) history.back();
  else closeTab();
});

async function loadTimer() {
  try {
    const data = await chrome.storage.local.get("timerState");
    const state = data.timerState;
    if (!state || state.status !== "running" || !state.endTime) return;

    const badge = document.getElementById("timerBadge");
    badge.style.display = "inline-block";

    (function tick() {
      const remaining = Math.max(0, state.endTime - Date.now());
      const totalSec = Math.ceil(remaining / 1000);
      const m = Math.floor(totalSec / 60);
      const s = totalSec % 60;
      badge.textContent =
        `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")} remaining`;
      if (remaining > 0) setTimeout(tick, 500);
      else badge.textContent = "Done! ✓";
    })();
  } catch { /* ignore */ }
}

loadTimer();
