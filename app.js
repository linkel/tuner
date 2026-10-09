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
  guitar: "acoustic", // "acoustic" (3+3) | "electric" (6-in-line)
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
    if (["acoustic", "electric"].includes(saved.guitar)) state.guitar = saved.guitar;
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

/* ================= Debug overlay ================= */

// Toggle by tapping the A4 calibration readout 5 times quickly. Shows audio
// and mic state live, plus a short event log, for diagnosing glitches on
// the phone itself (persists across launches until toggled off).
let debugOn = localStorage.getItem("tuner-debug") === "1";
const debugLines = [];

function debugLog(msg) {
  debugLines.push(new Date().toLocaleTimeString() + "  " + msg);
  if (debugLines.length > 8) debugLines.shift();
}

function renderDebug() {
  let el = document.getElementById("debug");
  if (!debugOn) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement("pre");
    el.id = "debug";
    document.body.appendChild(el);
  }
  const track = micStream && micStream.getAudioTracks()[0];
  let rms = 0;
  if (micBuf) { for (let i = 0; i < WINDOW; i++) rms += micBuf[i] * micBuf[i]; rms = Math.sqrt(rms / WINDOW); }
  el.textContent =
    "ctx: " + (ctx ? ctx.state + " " + ctx.sampleRate + " Hz" : "none") +
    "   session: " + (navigator.audioSession ? navigator.audioSession.type : "n/a") + "\n" +
    "mic: " + (track ? track.readyState + (track.muted ? " MUTED" : "") : "off") +
    "   rms: " + rms.toFixed(4) + "\n" + debugLines.join("\n");
}

/* ================= Audio ================= */

let ctx = null;
let masterGain = null;

// iOS Safari 17+: "playback" makes tones play even with the silent switch on,
// and keeps them out of the quieter voice-call routing iOS uses while the mic
// is open. Must be "play-and-record" while capturing.
function setAudioSession(type) {
  if (navigator.audioSession) {
    try { navigator.audioSession.type = type; } catch (e) { /* unsupported */ }
  }
}

function ensureAudio() {
  if (!ctx) {
    if (!micStream) setAudioSession("playback");
    ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: "interactive" });
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.9;
    masterGain.connect(ctx.destination);
    ctx.addEventListener("statechange", onAudioStateChange);
  }
  // iOS also has an "interrupted" state (calls, Siri, other apps' audio).
  if (ctx.state !== "running") ctx.resume().catch(() => {});
}

// Starting audio needs a user gesture. On touch screens pointerdown doesn't
// count, so also resume on the end of every tap; a note queued on pointerdown
// starts as soon as this lets the context run.
["pointerup", "touchend", "click"].forEach((type) => {
  document.addEventListener(type, () => {
    if (ctx && ctx.state !== "running") ctx.resume().catch(() => {});
  }, true);
});

/* ---- Additive plucked string ----
   Built harmonic by harmonic rather than from a Karplus-Strong noise burst,
   so brightness is fully under control: a pluck-position spectrum that rolls
   off steeply above ~2 kHz, with upper harmonics dying away faster than the
   fundamental, the way a real string mellows as it rings. */

const pluckCache = new Map(); // "midi@a4" -> AudioBuffer

const PLUCK_SECONDS = 4;
const PLUCK_POS = 0.2;      // pluck point as a fraction of string length
const PLUCK_TILT = 1.0;     // harmonic amplitude falls as 1 / h^tilt
const PLUCK_CUTOFF = 2000;  // Hz; -12 dB/octave above this
// Hz; partials below this are weakened, as a guitar body radiates them weakly.
// Phone speakers can't reproduce them either, so their level is better spent
// on the midrange where the pitch is actually heard.
const PLUCK_BODY = 250;
const INHARMONICITY = 0.00008;

function renderPluck(freq, sr) {
  const n = Math.floor(sr * PLUCK_SECONDS);
  const acc = new Float64Array(n);
  const sustain = 6 * Math.pow(82 / freq, 0.3); // fundamental T60, seconds

  for (let h = 1; h <= 48; h++) {
    const f = h * freq * Math.sqrt(1 + INHARMONICITY * h * h);
    if (f > 6000 || f > sr * 0.45) break;
    const amp = Math.abs(Math.sin(Math.PI * h * PLUCK_POS)) / Math.pow(h, PLUCK_TILT) /
                Math.sqrt(1 + Math.pow(f / PLUCK_CUTOFF, 4)) /
                Math.sqrt(1 + Math.pow(PLUCK_BODY / f, 2));
    if (amp < 1e-4) continue; // node at the pluck point
    const t60 = sustain / (1 + Math.pow(f / 1000, 1.3));
    // Damped sinusoid amp * r^k * sin(w k + phase) via its two-term recurrence.
    const r = Math.pow(0.001, 1 / (t60 * sr));
    const w = 2 * Math.PI * f / sr;
    const c = 2 * r * Math.cos(w), r2 = r * r;
    const phase = h * 2.4; // spread phases to keep the peak (and loudness jumps) down
    let y0 = amp * Math.sin(phase);
    let y1 = amp * Math.sin(phase - w) / r;
    for (let k = 0; k < n; k++) {
      acc[k] += y0;
      const y = c * y0 - r2 * y1;
      y1 = y0;
      y0 = y;
    }
  }

  // Raised-cosine attack so the onset has no click, then normalize and
  // fade the tail to silence.
  const attack = Math.floor(sr * 0.008);
  for (let i = 0; i < attack; i++) acc[i] *= 0.5 - 0.5 * Math.cos(Math.PI * i / attack);
  let peak = 0;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(acc[i]));
  const norm = peak > 0 ? 0.8 / peak : 1;
  const fadeStart = n - Math.floor(sr * 0.3);
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = acc[i] * norm;
    if (i > fadeStart) v *= (n - i) / (n - fadeStart);
    data[i] = v;
  }
  return data;
}

function getPluckBuffer(midi) {
  const key = midi + "@" + state.a4;
  const cached = pluckCache.get(key);
  if (cached) return cached;
  const data = renderPluck(midiToFreq(midi), ctx.sampleRate);
  const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
  buf.copyToChannel(data, 0);
  pluckCache.set(key, buf);
  return buf;
}

// One note at a time: a new pluck quickly damps the previous one, so
// overlapping notes never stack up and clip.
let voice = null;

function pluck(midi) {
  ensureAudio();
  const now = ctx.currentTime;
  if (voice) {
    voice.gain.gain.setTargetAtTime(0, now, 0.02);
    voice.src.stop(now + 0.25);
  }
  const src = ctx.createBufferSource();
  src.buffer = getPluckBuffer(midi);
  const gain = ctx.createGain();
  src.connect(gain);
  gain.connect(masterGain);
  src.start(now);
  voice = { src, gain };
}

/* ================= Pitch detection (MPM / NSDF) ================= */

let micStream = null;
let micSource = null;
let analyser = null;
let micBuf = null;
let micStarting = false;
let silentSince = null;    // when the mic last started delivering pure digital silence
let lastAutoRestart = -Infinity;

const FFT_SIZE = 4096;
const WINDOW = 2048;

// The mic only runs while the Listen tab is showing. iOS kills capture when
// the page is backgrounded anyway, and an open mic switches iOS into a
// quieter call-style audio mode that would muffle the Play tab's tones.
function micWanted() {
  return paneIndex === 1 && document.visibilityState === "visible";
}

function micLive() {
  return !!micStream && micStream.getAudioTracks().some((t) => t.readyState === "live");
}

async function startMic() {
  if (micLive() || micStarting) return;
  stopMic();
  micStarting = true;
  // Only mention permission if we're actually kept waiting (i.e. prompted),
  // so re-opening the tab doesn't flash the message.
  const waitMsg = setTimeout(() => setMicMsg("Waiting for microphone permission…", false), 300);
  try {
    setAudioSession("play-and-record");
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    if (!micWanted()) {               // user swiped away while we waited
      stream.getTracks().forEach((t) => t.stop());
      setAudioSession("playback");
      return;
    }
    micStream = stream;
    ensureAudio();
    micSource = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    micSource.connect(analyser);
    micBuf = new Float32Array(FFT_SIZE);
    silentSince = null;
    stream.getAudioTracks().forEach((t) => {
      t.addEventListener("ended", () => {
        debugLog("mic track ended");
        if (micStream === stream && micWanted()) restartMic();
      });
      t.addEventListener("mute", () => debugLog("mic track muted"));
      t.addEventListener("unmute", () => debugLog("mic track unmuted"));
    });
    micMsg.classList.add("hidden");
    debugLog("mic started @ " + ctx.sampleRate + " Hz");
  } catch (e) {
    setAudioSession("playback");
    debugLog("getUserMedia failed: " + e.name);
    setMicMsg(e.name === "NotAllowedError"
      ? "Microphone access was blocked. Allow it in Settings for this site, then try again."
      : "Couldn't start the microphone. Tap to try again.", true);
  } finally {
    clearTimeout(waitMsg);
    micStarting = false;
  }
}

function stopMic() {
  if (micSource) micSource.disconnect();
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    setAudioSession("playback");
  }
  micStream = micSource = analyser = null;
}

function restartMic() {
  debugLog("restarting mic");
  stopMic();
  startMic();
}

// Called when the analyser hands back nothing but exact zeros. A real mic
// always has some noise, so this means capture or the audio context has
// silently died (common on iOS after an interruption). Try a fresh start
// once; if that doesn't revive it, ask for a tap, which also unlocks audio.
function onDeadMic(now) {
  if (silentSince === null) { silentSince = now; return; }
  if (now - silentSince < 1500) return;
  silentSince = null;
  if (now - lastAutoRestart > 8000) {
    lastAutoRestart = now;
    if (ctx.state !== "running") ctx.resume().catch(() => {});
    restartMic();
  } else {
    stopMic();
    setMicMsg("The microphone stopped responding.", true);
  }
}

function onAudioStateChange() {
  debugLog("audio context " + ctx.state);
  if (ctx.state === "running") {
    if (micLive()) micMsg.classList.add("hidden");
    return;
  }
  if (!micWanted()) return;
  ctx.resume().catch(() => {});
  // If resuming needs a gesture, the retry button provides one.
  setTimeout(() => {
    if (ctx.state !== "running" && micWanted()) setMicMsg("Audio was paused.", true);
  }, 500);
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
  let anySignal = false;
  for (let i = 0; i < FFT_SIZE; i += 16) if (micBuf[i] !== 0) { anySignal = true; break; }
  if (anySignal) silentSince = null;
  else onDeadMic(now);
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
  if (micWanted()) {
    ensureAudio();
    restartMic(); // iOS ends capture in the background; start clean
    requestWakeLock();
  } else if (document.visibilityState === "hidden") {
    stopMic();
  }
});

/* ================= UI: elements ================= */

const $ = (id) => document.getElementById(id);

const panes = $("panes");
const paneViewport = $("pane-viewport");
const paneListen = $("pane-listen");
const tabPlay = $("tab-play");
const tabListen = $("tab-listen");
const tabUnderline = $("tab-underline");
const headstockWrap = $("headstock-wrap");
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
    stopMic();
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

/* ================= UI: headstock ================= */

let lastString = null; // index into current tuning, for auto-repeat
let ringTimer = null;

const NUT_TOP = 370;
const NUT_BOT = 380;

// Per-style geometry: headstock outline, nut extent, where each string
// (index 0 = low E side) crosses the nut, and its peg post + knob spot.
const HEADSTOCKS = {
  // Acoustic 3+3: low strings up the left, high strings down the right.
  acoustic: {
    outline: "M 95 388 L 95 78 Q 95 56 117 56 L 138 56 Q 150 66 162 56 L 183 56 Q 205 56 205 78 L 205 388 Z",
    nut: [95, 205],
    nutXs: [105, 123, 141, 159, 177, 195],
    pegs: [
      { post: [113, 265], knob: [58, 265] },
      { post: [113, 175], knob: [58, 175] },
      { post: [113, 85],  knob: [58, 85] },
      { post: [187, 85],  knob: [242, 85] },
      { post: [187, 175], knob: [242, 175] },
      { post: [187, 265], knob: [242, 265] },
    ],
  },
  // Electric 6-in-line (Fender-style): all knobs on one side,
  // low E's peg closest to the nut.
  electric: {
    outline: "M 112 388 L 104 100 Q 102 62 140 62 L 198 66 Q 230 68 216 94 Q 203 118 199 158 Q 193 210 192 388 Z",
    nut: [110, 190],
    nutXs: [119, 131.4, 143.8, 156.2, 168.6, 181],
    pegs: [
      { post: [120, 330], knob: [58, 330] },
      { post: [119, 280], knob: [58, 280] },
      { post: [118, 230], knob: [58, 230] },
      { post: [117, 180], knob: [58, 180] },
      { post: [116, 130], knob: [58, 130] },
      { post: [115, 80],  knob: [58, 80] },
    ],
  },
};

function pegLabelSvg(noteStr) {
  const m = noteStr.match(/^([A-G][b#]?)(\d)$/);
  return noteLabel(m[1]) + "<tspan class='oct' dy='3'>" + m[2] + "</tspan>";
}

function buildHeadstock() {
  const t = currentTuning();
  const hs = HEADSTOCKS[state.guitar];
  let s = "<svg id='headstock-svg' viewBox='0 46 300 372'>";
  s += "<path class='hs-body' d='" + hs.outline + "'/>";
  s += "<rect class='hs-nut' x='" + hs.nut[0] + "' y='" + NUT_TOP + "' width='" +
       (hs.nut[1] - hs.nut[0]) + "' height='" + (NUT_BOT - NUT_TOP) + "' rx='3'/>";
  hs.nutXs.forEach((x, i) => {
    const w = (2.4 - 0.22 * i).toFixed(2);
    const post = hs.pegs[i].post;
    // String: nut to peg post, plus a stub below the nut toward the neck.
    s += "<line class='hs-string' x1='" + x + "' y1='" + NUT_TOP + "' x2='" + post[0] +
         "' y2='" + post[1] + "' stroke-width='" + w + "'/>";
    s += "<line class='hs-string' x1='" + x + "' y1='" + NUT_BOT + "' x2='" + x +
         "' y2='396' stroke-width='" + w + "'/>";
    s += "<text class='hs-strnum' x='" + x + "' y='411'>" + (6 - i) + "</text>";
  });
  hs.pegs.forEach((p, i) => {
    s += "<g class='peg' data-index='" + i + "'>" +
         "<line class='shaft' x1='" + p.post[0] + "' y1='" + p.post[1] + "' x2='" + p.knob[0] + "' y2='" + p.knob[1] + "'/>" +
         "<circle class='post' cx='" + p.post[0] + "' cy='" + p.post[1] + "' r='5'/>" +
         "<ellipse class='knob' cx='" + p.knob[0] + "' cy='" + p.knob[1] + "' rx='28' ry='19'/>" +
         "<text class='peg-label' x='" + p.knob[0] + "' y='" + (p.knob[1] + 6) + "'>" + pegLabelSvg(t.strings[i]) + "</text>" +
         "</g>";
  });
  s += "</svg>";
  headstockWrap.innerHTML = s;
}

// How far (in SVG units) from a peg's knob-to-post line a tap still counts.
const PEG_REACH = 50;

function distToSegment(x, y, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - a[0] - t * dx, y - a[1] - t * dy);
}

// Any touch near a peg plays the closest one, so there are no dead zones
// between or around the knobs. Fires on touch-down for an instant response
// (a click would wait for lift-off and is dropped if the finger slides).
headstockWrap.addEventListener("pointerdown", (e) => {
  const svg = headstockWrap.querySelector("svg");
  const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(svg.getScreenCTM().inverse());
  let best = -1, bestDist = PEG_REACH;
  HEADSTOCKS[state.guitar].pegs.forEach((p, i) => {
    const d = distToSegment(pt.x, pt.y, p.knob, p.post);
    if (d < bestDist) { bestDist = d; best = i; }
  });
  if (best >= 0) playString(best);
});

function playString(idx) {
  const t = currentTuning();
  pluck(noteToMidi(t.strings[idx]));
  lastString = idx;
  clearTimeout(ringTimer);
  headstockWrap.querySelectorAll(".peg").forEach((g) => {
    g.classList.toggle("ringing", +g.dataset.index === idx);
  });
  ringTimer = setTimeout(() => {
    headstockWrap.querySelectorAll(".peg").forEach((g) => g.classList.remove("ringing"));
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
    buildHeadstock();
    lastString = null;
  });
  tuningRow.appendChild(b);
});

document.querySelectorAll(".guitar-chip").forEach((b) => {
  b.addEventListener("click", () => {
    state.guitar = b.dataset.guitar;
    saveState();
    selectChip($("guitar-row"), (c) => c.dataset.guitar === state.guitar);
    buildHeadstock();
  });
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

micRetry.addEventListener("click", () => {
  ensureAudio();
  restartMic();
});

/* ================= Animation loop ================= */

let debugFrame = 0;

function loop(now) {
  if (paneIndex === 1 && micStream) analyzeFrame(now);
  if (paneIndex === 1) renderFrame(now);
  if (++debugFrame % 15 === 0) renderDebug();
  requestAnimationFrame(loop);
}

let debugTaps = [];
a4Value.addEventListener("click", () => {
  const now = performance.now();
  debugTaps = debugTaps.filter((t) => now - t < 2000).concat(now);
  if (debugTaps.length >= 5) {
    debugTaps = [];
    debugOn = !debugOn;
    localStorage.setItem("tuner-debug", debugOn ? "1" : "0");
  }
});

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
selectChip($("guitar-row"), (c) => c.dataset.guitar === state.guitar);
buildHeadstock();
goTo(0);
requestAnimationFrame(loop);

/* Service worker */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
