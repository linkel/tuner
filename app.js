"use strict";

/* ================= State ================= */

const TUNINGS = [
  { id: "standard", name: "Standard", strings: ["E2", "A2", "D3", "G3", "B3", "E4"] },
  { id: "dropd",    name: "Drop D",   strings: ["D2", "A2", "D3", "G3", "B3", "E4"] },
  { id: "eb",       name: "E♭ Std", strings: ["Eb2", "Ab2", "Db3", "Gb3", "Bb3", "Eb4"] },
  { id: "dadgad",   name: "DADGAD",   strings: ["D2", "A2", "D3", "G3", "A3", "D4"] },
  { id: "openg",    name: "Open G",   strings: ["D2", "G2", "D3", "G3", "B3", "D4"] },
  { id: "opend",    name: "Open D",   strings: ["D2", "A2", "D3", "F#3", "A3", "D4"] },
];

const state = {
  tuning: "standard",
  a4: 440,
  lock: "auto",       // "auto" (chromatic) | "strings"
  repeat: false,
};

const A4_MIN = 430, A4_MAX = 450;

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem("tuner-settings"));
    if (!saved) return;
    if (TUNINGS.some((t) => t.id === saved.tuning)) state.tuning = saved.tuning;
    if (saved.a4 >= A4_MIN && saved.a4 <= A4_MAX) state.a4 = Math.round(saved.a4);
    if (["auto", "strings"].includes(saved.lock)) state.lock = saved.lock;
    if (typeof saved.repeat === "boolean") state.repeat = saved.repeat;
  } catch (e) { /* corrupted storage — use defaults */ }
}

function saveState() {
  localStorage.setItem("tuner-settings", JSON.stringify(state));
}

/* ================= Notes ================= */

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function noteToMidi(name) {
  const m = name.match(/^([A-G])([b#]?)(\d)$/);
  let s = SEMITONES[m[1]];
  if (m[2] === "#") s++;
  if (m[2] === "b") s--;
  return (parseInt(m[3], 10) + 1) * 12 + s;
}

function midiToFreq(midi) {
  return state.a4 * Math.pow(2, (midi - 69) / 12);
}

// Display label: prefer flats for the Eb tuning's string names, sharps elsewhere.
function noteLabel(name) {
  return name.replace("#", "♯").replace(/([A-G])b/, "$1♭");
}

function currentTuning() {
  return TUNINGS.find((t) => t.id === state.tuning);
}

/* ================= Audio ================= */

let ctx = null;
let masterGain = null;

function ensureAudio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.9;
    masterGain.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && ctx) ctx.resume();
});

/* ---- Karplus-Strong plucked string ---- */

const pluckCache = new Map(); // "midi@a4" -> AudioBuffer

function getPluckBuffer(midi) {
  const key = midi + "@" + state.a4;
  const cached = pluckCache.get(key);
  if (cached) return cached;

  const freq = midiToFreq(midi);
  const sr = ctx.sampleRate;
  const seconds = 4;
  const n = Math.floor(sr * seconds);
  const data = new Float32Array(n);

  // Fractional delay line. The two-point average adds half a sample of
  // delay, so aim the interpolated read at (period - 0.5) samples.
  const period = sr / freq;
  const d = period - 0.5;
  const di = Math.floor(d);
  const df = d - di;
  const init = di + 3;

  // Excitation: lightly lowpassed noise for a softer pick attack…
  let prev = 0;
  for (let i = 0; i < init; i++) {
    const w = Math.random() * 2 - 1;
    data[i] = (w + prev) / 2;
    prev = w;
  }
  // …with a pick-position comb (~12% along the string) for realism.
  const pick = Math.max(1, Math.round(period * 0.12));
  for (let i = init - 1; i >= pick; i--) data[i] -= 0.5 * data[i - pick];

  // Loop gain sets sustain: about -60 dB after 5 seconds.
  const g = Math.pow(0.001, 1 / (freq * 5));
  for (let i = init; i < n; i++) {
    const x0 = data[i - di] * (1 - df) + data[i - di - 1] * df;
    const x1 = data[i - di - 1] * (1 - df) + data[i - di - 2] * df;
    data[i] = g * 0.5 * (x0 + x1);
  }

  // Normalize and fade the tail to silence.
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(data[i]));
  const norm = peak > 0 ? 0.8 / peak : 1;
  const fadeStart = n - Math.floor(sr * 0.3);
  for (let i = 0; i < n; i++) {
    let v = data[i] * norm;
    if (i > fadeStart) v *= (n - i) / (n - fadeStart);
    data[i] = v;
  }

  const buf = ctx.createBuffer(1, n, sr);
  buf.copyToChannel(data, 0);
  pluckCache.set(key, buf);
  return buf;
}

function pluck(midi) {
  ensureAudio();
  const src = ctx.createBufferSource();
  src.buffer = getPluckBuffer(midi);
  src.connect(masterGain);
  src.start();
}

/* ================= Pitch detection (MPM / NSDF) ================= */

let micStream = null;
let analyser = null;
let micBuf = null;

const FFT_SIZE = 4096;
const WINDOW = 2048;

async function startMic() {
  if (micStream) return;
  setMicMsg("Waiting for microphone permission…", false);
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    ensureAudio();
    const source = ctx.createMediaStreamSource(micStream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    source.connect(analyser);
    micBuf = new Float32Array(FFT_SIZE);
    micMsg.classList.add("hidden");
  } catch (e) {
    micStream = null;
    setMicMsg("Microphone access was blocked. Allow it in Settings for this site, then try again.", true);
  }
}

function setMicMsg(text, showRetry) {
  micMsgText.textContent = text;
  micRetry.classList.toggle("hidden", !showRetry);
  micMsg.classList.remove("hidden");
}

/* McLeod Pitch Method: normalized square difference + key-maximum picking.
   Robust against the octave errors plain FFT peak-picking makes on guitar. */
function detectPitch(buf, sr) {
  let rms = 0;
  for (let i = 0; i < WINDOW; i++) rms += buf[i] * buf[i];
  rms = Math.sqrt(rms / WINDOW);
  if (rms < 0.01) return null;

  const maxLag = Math.min(Math.floor(sr / 55), FFT_SIZE - WINDOW);   // down to ~55 Hz
  const minLag = Math.floor(sr / 1200);                              // up to ~1.2 kHz
  const nsdf = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let ac = 0, m = 0;
    for (let i = 0; i < WINDOW; i++) {
      const a = buf[i], b = buf[i + lag];
      ac += a * b;
      m += a * a + b * b;
    }
    nsdf[lag] = m > 0 ? (2 * ac) / m : 0;
  }

  // Collect key maxima: highest point between each positive-going and
  // negative-going zero crossing of the NSDF.
  const maxima = [];
  let lag = minLag;
  while (lag <= maxLag && nsdf[lag] > 0) lag++;      // skip the initial lobe
  while (lag <= maxLag) {
    while (lag <= maxLag && nsdf[lag] <= 0) lag++;
    let bestLag = -1, bestVal = 0;
    while (lag <= maxLag && nsdf[lag] > 0) {
      if (nsdf[lag] > bestVal) { bestVal = nsdf[lag]; bestLag = lag; }
      lag++;
    }
    if (bestLag > 0) maxima.push([bestLag, bestVal]);
  }
  if (!maxima.length) return null;

  let highest = 0;
  for (const [, v] of maxima) highest = Math.max(highest, v);
  if (highest < 0.85) return null;                   // no clear pitch

  const threshold = 0.93 * highest;
  let chosen = maxima[0][0];
  for (const [l, v] of maxima) {
    if (v >= threshold) { chosen = l; break; }
  }

  // Parabolic interpolation around the chosen lag for sub-sample accuracy.
  let refined = chosen;
  if (chosen > minLag && chosen < maxLag) {
    const y0 = nsdf[chosen - 1], y1 = nsdf[chosen], y2 = nsdf[chosen + 1];
    const denom = 2 * (2 * y1 - y0 - y2);
    if (Math.abs(denom) > 1e-9) refined = chosen + (y2 - y0) / denom;
  }
  return sr / refined;
}

/* ================= Listen-mode readout ================= */

const IN_TUNE_CENTS = 3;
const DIAL_RANGE_CENTS = 50;
const DIAL_RANGE_DEG = 45;

let dispCents = 0;          // eased needle position
let targetCents = 0;
let voiced = false;
let lastVoicedAt = 0;
let inTuneSince = null;
let frameToggle = false;    // detect on alternate frames (~30 fps)

function analyzeFrame(now) {
  if (!analyser) return;
  frameToggle = !frameToggle;
  if (!frameToggle) return;

  analyser.getFloatTimeDomainData(micBuf);
  const freq = detectPitch(micBuf, ctx.sampleRate);

  if (freq) {
    voiced = true;
    lastVoicedAt = now;
    let noteHtml, hint = "", cents;

    if (state.lock === "strings") {
      const t = currentTuning();
      let best = 0, bestDiff = Infinity;
      t.strings.forEach((s, i) => {
        const diff = Math.abs(Math.log2(freq / midiToFreq(noteToMidi(s))));
        if (diff < bestDiff) { bestDiff = diff; best = i; }
      });
      const target = midiToFreq(noteToMidi(t.strings[best]));
      cents = 1200 * Math.log2(freq / target);
      noteHtml = labelHtml(t.strings[best]);
      hint = "String " + (6 - best);
    } else {
      const midiFloat = 69 + 12 * Math.log2(freq / state.a4);
      const midi = Math.round(midiFloat);
      cents = (midiFloat - midi) * 100;
      const octave = Math.floor(midi / 12) - 1;
      noteHtml = NOTE_NAMES[((midi % 12) + 12) % 12] + "<sub>" + octave + "</sub>";
    }

    targetCents = Math.max(-DIAL_RANGE_CENTS, Math.min(DIAL_RANGE_CENTS, cents));
    noteName.innerHTML = noteHtml;
    const r = Math.round(cents);
    centsReadout.textContent = (r > 0 ? "+" : "") + r + " cents";
    stringHint.textContent = hint;
  } else if (now - lastVoicedAt > 600) {
    voiced = false;
    inTuneSince = null;
  }
}

function labelHtml(noteName_) {
  const m = noteName_.match(/^([A-G][b#]?)(\d)$/);
  return noteLabel(m[1]) + "<sub>" + m[2] + "</sub>";
}

function renderFrame(now) {
  const pane = paneListen;
  if (voiced) {
    dispCents += (targetCents - dispCents) * 0.18;

    const inTol = Math.abs(targetCents) <= IN_TUNE_CENTS;
    if (inTol) {
      if (inTuneSince === null) inTuneSince = now;
    } else {
      inTuneSince = null;
    }
    pane.classList.toggle("in-tune", inTuneSince !== null && now - inTuneSince > 700);
    pane.classList.add("voiced");
    pane.classList.remove("idle");

    // Green at 0 cents through amber to red at full deflection.
    const a = Math.min(Math.abs(dispCents), DIAL_RANGE_CENTS) / DIAL_RANGE_CENTS;
    const hue = 130 * (1 - a);
    glow.style.background =
      "radial-gradient(ellipse 90% 70% at 50% 42%, hsla(" + hue + ", 75%, 45%, 0.33) 0%, transparent 72%)";
  } else {
    dispCents += (0 - dispCents) * 0.06;
    pane.classList.remove("voiced", "in-tune");
    pane.classList.add("idle");
    noteName.textContent = "—";
    centsReadout.textContent = micStream ? "Listening…" : "";
    stringHint.textContent = "";
  }

  const angle = (dispCents / DIAL_RANGE_CENTS) * DIAL_RANGE_DEG;
  needle.setAttribute("transform", "rotate(" + angle + " 150 162)");
}

/* ================= Wake lock (Listen tab keeps screen on) ================= */

let wakeLock = null;

async function requestWakeLock() {
  try {
    if ("wakeLock" in navigator) wakeLock = await navigator.wakeLock.request("screen");
  } catch (e) { /* not critical */ }
}

function releaseWakeLock() {
  if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && paneIndex === 1) requestWakeLock();
});

/* ================= UI: elements ================= */

const $ = (id) => document.getElementById(id);

const panes = $("panes");
const paneViewport = $("pane-viewport");
const paneListen = $("pane-listen");
const tabPlay = $("tab-play");
const tabListen = $("tab-listen");
const tabUnderline = $("tab-underline");
const stringGrid = $("string-grid");
const glow = $("glow");
const needle = $("needle");
const noteName = $("note-name");
const centsReadout = $("cents-readout");
const stringHint = $("string-hint");
const micMsg = $("mic-msg");
const micMsgText = $("mic-msg-text");
const micRetry = $("mic-retry");
const a4Value = $("a4-value");
const tuningRow = $("tuning-row");

/* ================= UI: swipeable panes ================= */

let paneIndex = 0;

function paneWidth() { return paneViewport.clientWidth; }

function setOffset(px, dragging) {
  panes.classList.toggle("dragging", dragging);
  tabUnderline.classList.toggle("dragging", dragging);
  panes.style.transform = "translateX(" + -px + "px)";
  const frac = px / paneWidth();
  tabUnderline.style.transform = "translateX(" + frac * 100 + "%) scaleX(0.5)";
}

function goTo(i) {
  paneIndex = Math.max(0, Math.min(1, i));
  setOffset(paneIndex * paneWidth(), false);
  tabPlay.classList.toggle("active", paneIndex === 0);
  tabListen.classList.toggle("active", paneIndex === 1);
  if (paneIndex === 1) {
    ensureAudio();
    startMic();
    requestWakeLock();
  } else {
    releaseWakeLock();
  }
}

tabPlay.addEventListener("click", () => goTo(0));
tabListen.addEventListener("click", () => goTo(1));
window.addEventListener("resize", () => setOffset(paneIndex * paneWidth(), false));

// Touch swipe with horizontal-intent detection
let touchStartX = 0, touchStartY = 0, touchStartT = 0;
let touchBase = 0, touchDX = 0;
let swiping = null; // null = undecided, true = ours, false = vertical/abandoned

paneViewport.addEventListener("touchstart", (e) => {
  if (e.touches.length !== 1) return;
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
  touchStartT = performance.now();
  touchBase = paneIndex * paneWidth();
  touchDX = 0;
  swiping = null;
}, { passive: true });

paneViewport.addEventListener("touchmove", (e) => {
  if (swiping === false) return;
  const dx = e.touches[0].clientX - touchStartX;
  const dy = e.touches[0].clientY - touchStartY;
  if (swiping === null) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    swiping = Math.abs(dx) > Math.abs(dy);
    if (!swiping) return;
  }
  e.preventDefault();
  touchDX = dx;
  let px = touchBase - dx;
  // Rubber-band past the edges
  if (px < 0) px = px / 3;
  if (px > paneWidth()) px = paneWidth() + (px - paneWidth()) / 3;
  setOffset(px, true);
}, { passive: false });

paneViewport.addEventListener("touchend", () => {
  if (swiping !== true) return;
  const dt = performance.now() - touchStartT;
  const flick = Math.abs(touchDX) > 30 && dt < 300;
  let next = paneIndex;
  if (flick || Math.abs(touchDX) > paneWidth() / 3) {
    next = touchDX < 0 ? paneIndex + 1 : paneIndex - 1;
  }
  goTo(next);
  swiping = false;
});

paneViewport.addEventListener("touchcancel", () => {
  if (swiping === true) goTo(paneIndex);
  swiping = false;
});

/* ================= UI: string buttons ================= */

let lastString = null; // index into current tuning, for auto-repeat
let ringTimer = null;

function buildStrings() {
  const t = currentTuning();
  stringGrid.innerHTML = "";
  // Headstock-ish 3+3: low strings on the left, high on the right, high at top.
  const order = [2, 3, 1, 4, 0, 5];
  for (const idx of order) {
    const b = document.createElement("button");
    b.className = "string-btn";
    b.dataset.index = idx;
    b.innerHTML = "<span class='note'>" + labelHtml(t.strings[idx]) + "</span>" +
                  "<span class='strnum'>STR " + (6 - idx) + "</span>";
    b.addEventListener("click", () => playString(idx));
    stringGrid.appendChild(b);
  }
}

function playString(idx) {
  const t = currentTuning();
  pluck(noteToMidi(t.strings[idx]));
  lastString = idx;
  clearTimeout(ringTimer);
  stringGrid.querySelectorAll(".string-btn").forEach((b) => {
    b.classList.toggle("ringing", +b.dataset.index === idx);
  });
  ringTimer = setTimeout(() => {
    stringGrid.querySelectorAll(".string-btn").forEach((b) => b.classList.remove("ringing"));
  }, 900);
}

// Auto-repeat: re-pluck the last string every 3 s while on the Play tab.
setInterval(() => {
  if (state.repeat && lastString !== null && paneIndex === 0 && ctx && document.visibilityState === "visible") {
    playString(lastString);
  }
}, 3000);

$("repeat-check").addEventListener("change", (e) => {
  state.repeat = e.target.checked;
  saveState();
});

/* ================= UI: settings ================= */

function selectChip(row, matchFn) {
  row.querySelectorAll(".chip").forEach((c) => c.classList.toggle("selected", matchFn(c)));
}

TUNINGS.forEach((t) => {
  const b = document.createElement("button");
  b.className = "chip";
  b.textContent = t.name;
  b.dataset.tuning = t.id;
  b.addEventListener("click", () => {
    state.tuning = t.id;
    saveState();
    selectChip(tuningRow, (c) => c.dataset.tuning === t.id);
    buildStrings();
    lastString = null;
  });
  tuningRow.appendChild(b);
});

document.querySelectorAll(".lock-chip").forEach((b) => {
  b.addEventListener("click", () => {
    state.lock = b.dataset.lock;
    saveState();
    selectChip($("lock-row"), (c) => c.dataset.lock === state.lock);
  });
});

function setA4(v) {
  state.a4 = Math.max(A4_MIN, Math.min(A4_MAX, Math.round(v)));
  a4Value.textContent = "A4 = " + state.a4 + " Hz";
  pluckCache.clear();
  saveState();
}

function holdable(el, step) {
  let t1 = null, t2 = null;
  const fire = () => setA4(state.a4 + step);
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    fire();
    t1 = setTimeout(() => { t2 = setInterval(fire, 90); }, 450);
  });
  const up = () => { clearTimeout(t1); clearInterval(t2); };
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  el.addEventListener("pointerleave", up);
}

holdable($("a4-minus"), -1);
holdable($("a4-plus"), +1);

micRetry.addEventListener("click", startMic);

/* ================= Animation loop ================= */

function loop(now) {
  if (paneIndex === 1 && micStream) analyzeFrame(now);
  if (paneIndex === 1) renderFrame(now);
  requestAnimationFrame(loop);
}

/* ================= Dial ticks ================= */

(function buildDial() {
  const g = $("dial-ticks");
  const cx = 150, cy = 162;
  for (let c = -DIAL_RANGE_CENTS; c <= DIAL_RANGE_CENTS; c += 10) {
    const angle = (c / DIAL_RANGE_CENTS) * DIAL_RANGE_DEG * (Math.PI / 180);
    const r1 = c === 0 ? 118 : 126;
    const r2 = 140;
    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", cx + r1 * Math.sin(angle));
    line.setAttribute("y1", cy - r1 * Math.cos(angle));
    line.setAttribute("x2", cx + r2 * Math.sin(angle));
    line.setAttribute("y2", cy - r2 * Math.cos(angle));
    line.setAttribute("class", "dial-tick" + (c === 0 ? " center" : ""));
    g.appendChild(line);
  }
})();

/* ================= Init ================= */

loadState();
setA4(state.a4);
$("repeat-check").checked = state.repeat;
selectChip(tuningRow, (c) => c.dataset.tuning === state.tuning);
selectChip($("lock-row"), (c) => c.dataset.lock === state.lock);
buildStrings();
goTo(0);
requestAnimationFrame(loop);

/* Service worker */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
