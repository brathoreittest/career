const PIN = "110096";
const STORAGE_KEY = "hindiEnglishPracticeStateV2";
const WAKE_VISIBILITY_RETRY_MS = 250;

const splitCueWords = ["अबे", "भाई", "अरे", "चलो", "सुनो", "देखो", "रुको"];
const topicShiftPhrases = [
  "मुझे समझ नहीं",
  "समझ नहीं आ रहा",
  "पता नहीं",
  "लेकिन",
  "पर",
  "वैसे",
  "और",
  "फिर",
];

const dom = {
  pinScreen: document.getElementById("pinScreen"),
  appScreen: document.getElementById("appScreen"),
  pinForm: document.getElementById("pinForm"),
  pinInput: document.getElementById("pinInput"),
  pinError: document.getElementById("pinError"),
  fileInput: document.getElementById("fileInput"),
  fileName: document.getElementById("fileName"),
  original: document.getElementById("original"),
  translated: document.getElementById("translated"),
  playPauseBtn: document.getElementById("playPauseBtn"),
};

const state = {
  unlocked: false,
  dialogues: [], // [{ hindi, english }]
  index: 0,
  isPlaying: false,
  timeoutId: null,
  wakeLock: null,
  voices: [],
  fileName: "",
};

function loadStoredState() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    state.dialogues = Array.isArray(data.dialogues) ? data.dialogues : [];
    state.index = Number.isInteger(data.index) ? data.index : 0;
    state.fileName = typeof data.fileName === "string" ? data.fileName : "";
    clampIndex();
  } catch {
    state.dialogues = [];
    state.index = 0;
    state.fileName = "";
  }
}

function persistState() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      dialogues: state.dialogues,
      index: state.index,
      fileName: state.fileName,
    })
  );
}

function clampIndex() {
  if (state.index < 0) state.index = 0;
  if (state.index >= state.dialogues.length && state.dialogues.length > 0) {
    state.index = state.dialogues.length - 1;
  }
}

function detectLanguage(text) {
  return /[\u0900-\u097F]/.test(text) ? "hi" : "en";
}

function parseTimeToSeconds(value) {
  const m = value.match(/(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

function cleanSubtitleLine(line) {
  const noTags = line.replace(/<[^>]+>/g, " ");
  const noInlineTime = noTags
    .replace(/\b\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,3})?\b/g, " ")
    .replace(/\b\d{1,2}:\d{2,3}\s*(?:seconds?|secs?|s)\b/gi, " ")
    .replace(/\b\d{1,2}:\d{2}(?:[.,]\d{1,3})?\b/g, " ");

  const noSpeaker = noInlineTime.replace(/^\s*[A-Z][A-Z0-9 _-]{1,20}:\s*/g, "");

  if (/^\s*\[[^\]]+\]\s*$/i.test(noSpeaker)) return "";
  if (/^[♪\s]+$/.test(noSpeaker)) return "";
  if (/\[(music|applause|laughter)\]/i.test(noSpeaker)) return "";

  return noSpeaker.replace(/\s+/g, " ").trim();
}

function parseSrt(raw) {
  const blocks = raw.replace(/\r/g, "").trim().split(/\n\s*\n/);
  const parsed = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((x) => x.trim()).filter(Boolean);
    if (!lines.length) continue;

    const timeLine = lines.find((line) => line.includes("-->"));
    if (!timeLine) continue;

    const [startRaw, endRaw] = timeLine.split("-->").map((x) => x.trim());
    const start = parseTimeToSeconds(startRaw || "");
    const end = parseTimeToSeconds(endRaw || "");

    const dialogueLines = lines.filter(
      (line) => !/^\d+$/.test(line) && !line.includes("-->")
    );

    const text = dialogueLines
      .map(cleanSubtitleLine)
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (!text) continue;
    parsed.push({ start, end, text });
  }

  return parsed;
}

function mergeByTimingGap(blocks, maxGap = 1.5) {
  if (!blocks.length) return [];
  const merged = [blocks[0]];

  for (let i = 1; i < blocks.length; i += 1) {
    const current = blocks[i];
    const prev = merged[merged.length - 1];
    const gap = Math.max(0, current.start - prev.end);

    if (gap < maxGap) {
      prev.end = Math.max(prev.end, current.end);
      prev.text = `${prev.text} ${current.text}`.replace(/\s+/g, " ").trim();
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

function removeRepeatedCaptions(lines) {
  const out = [];
  for (const text of lines) {
    if (!text) continue;
    if (!out.length) {
      out.push(text);
      continue;
    }

    const prev = out[out.length - 1];
    if (text === prev) continue;

    if (text.includes(prev)) {
      out[out.length - 1] = text;
      continue;
    }

    if (prev.includes(text)) {
      continue;
    }

    out.push(text);
  }
  return out;
}

function splitOnCues(text) {
  const parts = [text];
  for (const cue of splitCueWords) {
    for (let i = 0; i < parts.length; i += 1) {
      const p = parts[i];
      const re = new RegExp(`\\s+(?=${cue}\\b)`, "g");
      const split = p.split(re).map((x) => x.trim()).filter(Boolean);
      if (split.length > 1) {
        parts.splice(i, 1, ...split);
        i += split.length - 1;
      }
    }
  }
  return parts;
}

function splitOnTopicShift(text) {
  for (const phrase of topicShiftPhrases) {
    const idx = text.indexOf(phrase);
    if (idx > 18) {
      const a = text.slice(0, idx).trim();
      const b = text.slice(idx).trim();
      if (a && b) return [a, b];
    }
  }
  return [text];
}

function splitToNaturalChunks(line) {
  let chunks = line
    .split(/(?<=[?!।.!])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const commaExpanded = [];
  for (const c of chunks) {
    if (c.includes(",") && c.split(/\s+/).length > 8) {
      commaExpanded.push(...c.split(",").map((x) => x.trim()).filter(Boolean));
    } else {
      commaExpanded.push(c);
    }
  }

  const cueExpanded = commaExpanded.flatMap(splitOnCues);
  chunks = cueExpanded.flatMap(splitOnTopicShift).map((x) => x.trim()).filter(Boolean);
  return chunks;
}

function joinShortChunks(chunks, minWords = 7) {
  const out = [];
  let buffer = "";

  function words(text) {
    return text.trim().split(/\s+/).filter(Boolean).length;
  }

  for (const chunk of chunks) {
    buffer = buffer ? `${buffer} ${chunk}` : chunk;
    if (words(buffer) >= minWords) {
      out.push(buffer.trim());
      buffer = "";
    }
  }

  if (buffer) {
    if (out.length) {
      out[out.length - 1] = `${out[out.length - 1]} ${buffer}`.replace(/\s+/g, " ").trim();
    } else {
      out.push(buffer.trim());
    }
  }

  return out;
}

function colloquialEnglishPostprocess(text) {
  return text
    .replace(/\bBrother\b/gi, "Bro")
    .replace(/\bbuddy\b/gi, "bro")
    .replace(/\s+/g, " ")
    .trim();
}

async function translateText(text, sourceLang, targetLang) {
  const endpoint = localStorage.getItem("subtitleTranslateEndpoint") || "";

  if (endpoint) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, sourceLang, targetLang, style: "natural_spoken" }),
      });
      if (res.ok) {
        const data = await res.json();
        if (typeof data?.translation === "string" && data.translation.trim()) {
          return colloquialEnglishPostprocess(data.translation);
        }
      }
    } catch {
      // continue to fallback
    }
  }

  try {
    const pair = `${sourceLang}|${targetLang}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(pair)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error("web fallback failed");
    const data = await res.json();
    const translated = data?.responseData?.translatedText?.trim();
    if (translated) return colloquialEnglishPostprocess(translated);
  } catch {
    // final fallback
  }

  return `[${targetLang.toUpperCase()}] ${text}`;
}

async function buildDialoguesFromSrtText(raw) {
  const blocks = parseSrt(raw);
  const mergedByGap = mergeByTimingGap(blocks, 1.5);
  const deduped = removeRepeatedCaptions(mergedByGap.map((x) => x.text));

  const rawChunks = deduped.flatMap(splitToNaturalChunks);
  const finalChunks = joinShortChunks(rawChunks, 7);

  const dialogues = [];
  for (const chunk of finalChunks) {
    const lang = detectLanguage(chunk);
    if (lang === "hi") {
      const english = await translateText(chunk, "hi", "en");
      dialogues.push({ hindi: chunk, english });
    } else {
      const hindi = await translateText(chunk, "en", "hi");
      dialogues.push({ hindi, english: chunk });
    }
  }

  return dialogues;
}

function dynamicDelaySeconds(text) {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return words * 0.8 + 2;
}

function setPlayButtonLabel() {
  dom.playPauseBtn.textContent = state.isPlaying ? "Pause" : "Play";
}

function setEnglishVisible(text, visible) {
  dom.translated.textContent = text || "";
  if (visible) {
    dom.translated.classList.add("show");
  } else {
    dom.translated.classList.remove("show");
  }
}

function chooseVoice(langCode) {
  const candidates = state.voices;
  const hints = langCode === "hi-IN" ? ["hi-IN", "hi"] : ["en-US", "en-IN", "en-GB", "en"];
  for (const hint of hints) {
    const found = candidates.find((v) => (v.lang || "").toLowerCase().includes(hint.toLowerCase()));
    if (found) return found;
  }
  return null;
}

function speak(text, lang) {
  return new Promise((resolve) => {
    if (!window.speechSynthesis || !text) {
      resolve();
      return;
    }

    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang;
    utterance.rate = 0.9;
    const voice = chooseVoice(lang);
    if (voice) utterance.voice = voice;
    utterance.onend = () => resolve();
    utterance.onerror = () => resolve();
    speechSynthesis.speak(utterance);
  });
}

function clearFlowTimer() {
  if (state.timeoutId) {
    clearTimeout(state.timeoutId);
    state.timeoutId = null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => {
    state.timeoutId = setTimeout(() => {
      state.timeoutId = null;
      resolve();
    }, ms);
  });
}

async function acquireWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    state.wakeLock = await navigator.wakeLock.request("screen");
    state.wakeLock.addEventListener("release", () => {
      state.wakeLock = null;
    });
  } catch {
    // ignore
  }
}

async function releaseWakeLock() {
  if (state.wakeLock) {
    try {
      await state.wakeLock.release();
    } catch {
      // ignore
    }
    state.wakeLock = null;
  }
}

function renderCurrentDialogue(showEnglish = false) {
  const current = state.dialogues[state.index];
  if (!current) {
    dom.original.textContent = "Upload an .srt file to start practice.";
    setEnglishVisible("", false);
    return;
  }

  dom.original.textContent = current.hindi;
  setEnglishVisible(showEnglish ? current.english : "", showEnglish);
}

function stopPractice() {
  state.isPlaying = false;
  setPlayButtonLabel();
  clearFlowTimer();
  speechSynthesis.cancel();
  releaseWakeLock();
}

async function showDialogue() {
  if (!state.isPlaying) return;

  const current = state.dialogues[state.index];
  if (!current) {
    stopPractice();
    dom.original.textContent = "Practice complete. Upload another file to continue.";
    setEnglishVisible("", false);
    return;
  }

  renderCurrentDialogue(false);
  await speak(current.hindi, "hi-IN");
  if (!state.isPlaying) return;

  await sleep(dynamicDelaySeconds(current.hindi) * 1000);
  if (!state.isPlaying) return;

  setEnglishVisible(current.english, true);
  await speak(current.english, "en-US");
  if (!state.isPlaying) return;

  await sleep(4000);
  if (!state.isPlaying) return;

  state.index += 1;
  if (state.index >= state.dialogues.length) {
    state.index = state.dialogues.length;
  }
  persistState();

  if (state.index >= state.dialogues.length) {
    stopPractice();
    dom.original.textContent = "Practice complete. Upload another file to continue.";
    return;
  }

  showDialogue();
}

async function startPractice() {
  if (!state.dialogues.length) return;
  if (state.index >= state.dialogues.length) state.index = 0;
  state.isPlaying = true;
  setPlayButtonLabel();
  await acquireWakeLock();
  showDialogue();
}

function resumePreview() {
  if (!state.dialogues.length) {
    dom.fileName.textContent = "No file selected.";
    renderCurrentDialogue(false);
    setPlayButtonLabel();
    return;
  }

  clampIndex();
  dom.fileName.textContent = `${state.fileName || "Cached subtitles"} • ${state.dialogues.length} dialogues • Resume at ${state.index + 1}`;
  renderCurrentDialogue(true);
  setPlayButtonLabel();
}

function handleNewFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsText(file, "utf-8");
  });
}

async function onUpload(file) {
  stopPractice();
  dom.original.textContent = "Processing subtitles...";
  setEnglishVisible("", false);

  try {
    const raw = await handleNewFile(file);
    const dialogues = await buildDialoguesFromSrtText(raw);

    state.dialogues = dialogues;
    state.index = 0;
    state.fileName = file.name;
    persistState();

    dom.fileName.textContent = `${file.name} • ${dialogues.length} dialogues`;

    if (!dialogues.length) {
      dom.original.textContent = "No usable dialogues found in this .srt file.";
      return;
    }

    renderCurrentDialogue(false);
    await startPractice();
  } catch {
    dom.original.textContent = "Could not parse subtitle file.";
  }
}

function unlockApp() {
  state.unlocked = true;
  dom.pinScreen.classList.remove("active");
  dom.appScreen.classList.add("active");
  resumePreview();
}

function initVoices() {
  state.voices = speechSynthesis.getVoices();
}

dom.pinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (dom.pinInput.value === PIN) {
    dom.pinError.textContent = "";
    unlockApp();
  } else {
    dom.pinError.textContent = "Invalid PIN.";
  }
});

dom.fileInput.addEventListener("change", async (event) => {
  const [file] = event.target.files || [];
  if (!file) return;
  await onUpload(file);
  event.target.value = "";
});

dom.playPauseBtn.addEventListener("click", async () => {
  if (state.isPlaying) {
    stopPractice();
    return;
  }
  await startPractice();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state.isPlaying) {
    setTimeout(() => {
      if (state.isPlaying && !state.wakeLock) acquireWakeLock();
    }, WAKE_VISIBILITY_RETRY_MS);
  }
});

window.addEventListener("beforeunload", persistState);

if ("speechSynthesis" in window) {
  initVoices();
  speechSynthesis.onvoiceschanged = initVoices;
}

loadStoredState();
setPlayButtonLabel();
