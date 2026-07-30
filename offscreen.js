// Plays a short, subtle chime using the Web Audio API so no audio asset is
// needed. Runs in an offscreen document so sound works even when the popup is
// closed.

async function playChime() {
  const ctx = new (self.AudioContext || self.webkitAudioContext)();

  // Offscreen audio contexts often start suspended; resume before scheduling.
  if (ctx.state === "suspended") {
    try {
      await ctx.resume();
    } catch (e) {
      /* ignore */
    }
  }

  const now = ctx.currentTime;

  // Two soft notes (a gentle "ding-ding").
  const notes = [
    { freq: 880, start: 0.0 },
    { freq: 1174.66, start: 0.18 },
  ];

  notes.forEach(({ freq, start }) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;

    const t = now + start;
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);

    osc.connect(gain).connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.65);
  });

  // Close the context after playback to free resources.
  setTimeout(() => ctx.close().catch(() => {}), 1500);
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.target === "offscreen" && msg.type === "PLAY_SOUND") {
    playChime()
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err) }));
    return true;
  }
  return false;
});
