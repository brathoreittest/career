const PIN = "110096";
const CACHE_KEY = "subtitlePracticeCacheV1";
const MAX_FILES = 10;
const MIN_BATCH = 10;
const MAX_BATCH = 15;

const localCache = {
  get() {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY)) || { files: [], activeFileId: null };
    } catch {
      return { files: [], activeFileId: null };
    }
  },
  set(value) {
    localStorage.setItem(CACHE_KEY, JSON.stringify(value));
  },
};

const state = {
  unlocked: false,
  playing: false,
  paused: true,
  activeFileId: null,
  data: localCache.get(),
  voices: [],
  wakeLock: null,
  lastUtterance: null,
  antiSleepTimer: null,
  antiSleepTick: 0,
};

const pinScreen = document.getElementById("pinScreen");
const appScreen = document.getElementById("appScreen");
const pinForm = document.getElementById("pinForm");
const pinInput = document.getElementById("pinInput");
const pinError = document.getElementById("pinError");
const fileInput = document.getElementById("fileInput");
const fileNameEl = document.getElementById("fileName");
const originalEl = document.getElementById("original");
const translatedEl = document.getElementById("translated");
const playPauseBtn = document.getElementById("playPauseBtn");
const activityPulse = document.getElementById("activityPulse");

function saveState() {
  state.data.activeFileId = state.activeFileId;
  localCache.set(state.data);
}

function getActiveFile() {
  return state.data.files.find((f) => f.id === state.activeFileId) || null;
}

function detectLanguage(text) {
  return /[\u0900-\u097F]/.test(text) ? "hi" : "en";
}


function stripInlineTimestamps(text) {
  return text
    .replace(/\b\d{1,2}:\d{2,3}\s*(?:seconds?|secs?|s)\b/gi, " ")
    .replace(/\b\d{1,2}:\d{2}\s*(?:seconds?|secs?|s)\b/gi, " ")
    .replace(/\b\d{1,2}:\d{2,3}(?!\d)\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?\b/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?:[.,]\d{1,3})?\b/g, " ")
    .replace(/\b(?:seconds?|secs?)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseSrt(raw) {
  const lines = raw.replace(/\r/g, "").split("\n");
  const out = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^\d+$/.test(trimmed)) continue;
    if (/\d{2}:\d{2}:\d{2},\d{3}\s+-->\s+\d{2}:\d{2}:\d{2},\d{3}/.test(trimmed)) continue;
    const cleanText = stripInlineTimestamps(trimmed.replace(/<[^>]+>/g, "").trim());
    if (cleanText) out.push(cleanText);
  }
  return out.filter(Boolean);
}

function normalizeChunkWithoutWordChanges(lines) {
  const merged = [];
  for (const line of lines) {
    if (!line) continue;
    if (!merged.length) {
      merged.push(line);
      continue;
    }

    const previous = merged[merged.length - 1];
    const prevEnds = /[.!?।…]$/.test(previous);
    const startsLower = /^[a-z]/.test(line);
    const startsContinuation = /^[,;:)]/.test(line);
    if (!prevEnds || startsLower || startsContinuation) {
      merged[merged.length - 1] = `${previous} ${line}`.replace(/\s+/g, " ").trim();
    } else {
      merged.push(line);
    }
  }

  const split = [];
  for (const item of merged) {
    const parts = item.split(/(?<=[.!?।])\s+/).map((x) => x.trim()).filter(Boolean);
    split.push(...parts);
  }
  return split;
}

async function fixBatchWithApi(lines, lang) {
  const endpoint = localStorage.getItem("subtitleFixEndpoint") || "";
  if (!endpoint) return normalizeChunkWithoutWordChanges(lines);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lines, language: lang, policy: "merge_or_split_only_no_word_change" }),
    });
    if (!response.ok) throw new Error("batch fix failed");
    const data = await response.json();
    if (Array.isArray(data?.lines) && data.lines.length) return data.lines;
  } catch {
    // fallback intentionally silent
  }
  return normalizeChunkWithoutWordChanges(lines);
}

async function translateDialogue(text, sourceLang) {
  const endpoint = localStorage.getItem("subtitleTranslateEndpoint") || "";
  const targetLang = sourceLang === "hi" ? "en" : "hi";

  async function fallbackWebTranslate() {
    const pair = `${sourceLang}|${targetLang}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`;

    try {
      const response = await fetch(url, { method: "GET" });
      if (!response.ok) throw new Error("mymemory failed");
      const data = await response.json();
      const translated = data?.responseData?.translatedText?.trim();
      if (translated && translated.toLowerCase() !== text.trim().toLowerCase()) {
        return translated;
      }
    } catch {
      // ignore and return fallback below
    }

    return `[${targetLang.toUpperCase()}] ${text}`;
  }

  if (!endpoint) return fallbackWebTranslate();

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, sourceLang, targetLang }),
    });
    if (!response.ok) throw new Error("translation failed");
    const data = await response.json();
    return data?.translation || (await fallbackWebTranslate());
  } catch {
    return fallbackWebTranslate();
  }
}

function chooseVoiceForLanguage(lang) {
  const list = state.voices;
  const hints = lang === "hi" ? ["hi-IN", "hi", "hindi"] : ["en-IN", "en-US", "en-GB", "en", "english"];
  for (const hint of hints) {
    const match = list.find((v) => (v.lang || "").toLowerCase().includes(hint.toLowerCase()) || (v.name || "").toLowerCase().includes(hint.toLowerCase()));
    if (match) return match;
  }
  return list[0] || null;
}

function speak(text, lang) {
  return new Promise((resolve) => {
    if (!text || !window.speechSynthesis) {
      resolve();
      return;
    }

    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang === "hi" ? "hi-IN" : "en-US";
    const voice = chooseVoiceForLanguage(lang);
    if (voice) utterance.voice = voice;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    state.lastUtterance = utterance;
    window.speechSynthesis.speak(utterance);
  });
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sentenceDelaySeconds(text) {
  const wordCount = text.trim().split(/\s+/).filter(Boolean).length || 1;
  return (wordCount * 0.9) + 2;
}

function renderPair(pair, showTranslation = true) {
  originalEl.textContent = pair?.original || "No dialogue.";
  translatedEl.textContent = showTranslation ? (pair?.translated || "") : "...";
}

function setPlayButton() {
  playPauseBtn.textContent = state.paused ? "Play" : "Pause";
}

async function requestWakeLock() {
  if ("wakeLock" in navigator) {
    try {
      state.wakeLock = await navigator.wakeLock.request("screen");
      state.wakeLock.addEventListener("release", () => {
        state.wakeLock = null;
      });
    } catch {
      // fallback will run
    }
  }

  if (!state.antiSleepTimer) {
    state.antiSleepTimer = setInterval(() => {
      state.antiSleepTick += 1;
      activityPulse.style.transform = `translateX(${state.antiSleepTick % 2}px)`;
    }, 15000);
  }
}

async function processBatch(fileEntry) {
  if (fileEntry.pending.length === 0) return;

  const size = Math.min(MAX_BATCH, Math.max(MIN_BATCH, 12));
  const chunk = fileEntry.pending.slice(0, size);
  const fileLang = detectLanguage(chunk.join(" "));
  const fixed = await fixBatchWithApi(chunk, fileLang);

  for (const line of fixed) {
    const sourceLang = detectLanguage(line);
    const translated = await translateDialogue(line, sourceLang);
    fileEntry.processed.push({
      original: line,
      translated,
      sourceLang,
      targetLang: sourceLang === "hi" ? "en" : "hi",
    });
  }

  fileEntry.pending = fileEntry.pending.slice(chunk.length);
  saveState();
}

async function ensureProcessedAhead(fileEntry) {
  const remaining = fileEntry.processed.length - fileEntry.progress;
  if (remaining < 2 && fileEntry.pending.length > 0) {
    await processBatch(fileEntry);
  }
}

async function playbackLoop() {
  if (state.playing) return;
  state.playing = true;
  await requestWakeLock();

  while (!state.paused) {
    const fileEntry = getActiveFile();
    if (!fileEntry) break;

    await ensureProcessedAhead(fileEntry);
    const current = fileEntry.processed[fileEntry.progress];

    if (!current) {
      originalEl.textContent = "Reached end of dialogues.";
      translatedEl.textContent = "Upload another file to continue practicing.";
      state.paused = true;
      setPlayButton();
      break;
    }

    renderPair(current, false);
    await speak(current.original, current.sourceLang);
    await wait(sentenceDelaySeconds(current.original) * 1000);
    if (state.paused) break;

    renderPair(current, true);
    await speak(current.translated, current.targetLang);
    await wait(sentenceDelaySeconds(current.translated) * 1000);

    if (state.paused) break;
    fileEntry.progress += 1;
    saveState();
  }

  state.playing = false;
}

async function loadSrtFile(file) {
  const raw = await file.text();
  const lines = parseSrt(raw);

  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const entry = {
    id,
    fileName: file.name,
    processed: [],
    pending: lines,
    progress: 0,
    updatedAt: Date.now(),
  };

  state.data.files = [entry, ...state.data.files.filter((f) => f.fileName !== file.name)].slice(0, MAX_FILES);
  state.activeFileId = id;
  saveState();

  fileNameEl.textContent = `${file.name} (${lines.length} dialogues detected)`;
  originalEl.textContent = "Processing first batch...";
  translatedEl.textContent = "";
  await processBatch(entry);

  state.paused = false;
  setPlayButton();
  playbackLoop();
}

function resumeLastSession() {
  const activeId = state.data.activeFileId;
  const fallback = state.data.files[0]?.id || null;
  state.activeFileId = activeId || fallback;

  const fileEntry = getActiveFile();
  if (!fileEntry) {
    fileNameEl.textContent = "No cached file. Upload a subtitle file.";
    return;
  }

  fileNameEl.textContent = `${fileEntry.fileName} (resuming)`;
  const current = fileEntry.processed[fileEntry.progress] || fileEntry.processed[fileEntry.progress - 1];
  if (current) renderPair(current, true);

  state.paused = false;
  setPlayButton();
  playbackLoop();
}

function unlock() {
  state.unlocked = true;
  pinScreen.classList.remove("active");
  appScreen.classList.add("active");
  resumeLastSession();
}

pinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (pinInput.value === PIN) {
    pinError.textContent = "";
    unlock();
  } else {
    pinError.textContent = "Invalid PIN.";
  }
});

fileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (!file) return;

  window.speechSynthesis?.cancel();
  state.paused = true;
  state.playing = false;
  setPlayButton();
  await loadSrtFile(file);
  event.target.value = "";
});

playPauseBtn.addEventListener("click", () => {
  state.paused = !state.paused;
  setPlayButton();
  if (!state.paused) playbackLoop();
  else window.speechSynthesis?.cancel();
});

window.addEventListener("beforeunload", saveState);
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState === "visible" && !state.paused && !state.wakeLock) {
    await requestWakeLock();
  }
});

function initVoices() {
  state.voices = speechSynthesis.getVoices();
}

if ("speechSynthesis" in window) {
  initVoices();
  speechSynthesis.onvoiceschanged = initVoices;
}

setPlayButton();
