const DEFAULT_TARGET_LANGUAGE = "tr";
const MAX_LINE_LENGTH = 56;
const MAX_SEMANTIC_GROUP_CHARS = 500;
const MIN_SEMANTIC_GROUP_CHARS = 80;
const TIMESTAMP_GAP_THRESHOLD_SEC = 1.5;
const TRACK_CUE_LOAD_ATTEMPTS = 5;
const TRACK_CUE_LOAD_INTERVAL_MS = 140;

let translatedVideoKey = null;
let translationInProgress = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || !request.type) {
    return;
  }

  if (request.type === "translateCurrentVideo") {
    const targetLanguage = request.targetLanguage || DEFAULT_TARGET_LANGUAGE;

    translateCurrentVideo(targetLanguage)
      .then((meta) => {
        sendResponse({ ok: true, meta });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  if (request.type === "getTranslationState") {
    sendResponse({
      ok: true,
      applied: isTranslationAppliedForCurrentVideo(),
      inProgress: translationInProgress
    });
  }
});

async function translateCurrentVideo(targetLanguage) {
  if (translationInProgress) {
    throw new Error("Translation is already in progress.");
  }

  const vttUrl = findVttDownloadUrl();
  if (!vttUrl) {
    throw new Error("VTT subtitle download link not found on this page. Make sure the Downloads section is visible.");
  }

  const sourceLanguage = detectSourceLanguage() || "en";
  const sourceBase = getLanguageBase(sourceLanguage);
  const targetBase = getLanguageBase(targetLanguage);

  if (sourceBase && targetBase && sourceBase === targetBase) {
    throw new Error("Source and target languages are the same. Choose a different target language.");
  }

  const vttContent = await fetchVttContent(vttUrl);
  const parsedCues = parseVtt(vttContent);

  if (!parsedCues.length) {
    throw new Error("No subtitle cues found in the downloaded VTT file.");
  }

  const videoKey = buildVideoKeyFromVtt(vttUrl, parsedCues);

  if (translatedVideoKey && translatedVideoKey === videoKey) {
    throw new Error("Translation has already been applied for this video.");
  }

  translationInProgress = true;

  try {
    const groups = buildSemanticGroups(parsedCues);
    const segments = groups.map((group) => group.text);

    const response = await requestTranslations({
      segments,
      sourceLanguage,
      targetLanguage
    });

    const translations = response.translations;

    await applyTranslationsToVideo(parsedCues, groups, translations);

    translatedVideoKey = videoKey;

    return {
      translatedCount: parsedCues.length,
      groupCount: groups.length,
      mode: response.mode || "single",
      sourceLanguage
    };
  } finally {
    translationInProgress = false;
  }
}

function findVttDownloadUrl() {
  const subtitleLink = document.querySelector(
    'a[data-track-component="focused_lex_download_subtitle"]'
  );

  if (subtitleLink && subtitleLink.href) {
    return subtitleLink.href;
  }

  const downloadLinks = document.querySelectorAll("a[download]");

  for (const link of downloadLinks) {
    const download = (link.getAttribute("download") || "").toLowerCase();

    if (download.endsWith(".vtt") && link.href) {
      return link.href;
    }
  }

  const proxyLinks = document.querySelectorAll('a[href*="subtitleAssetProxy"]');

  for (const link of proxyLinks) {
    if (link.href && /fileExtension=vtt/i.test(link.href)) {
      return link.href;
    }
  }

  const trackElements = document.querySelectorAll("video track[src]");

  for (const track of trackElements) {
    const kind = (track.kind || "").toLowerCase();

    if (kind && kind !== "subtitles" && kind !== "captions") {
      continue;
    }

    if (track.src) {
      return track.src;
    }
  }

  return null;
}

function detectSourceLanguage() {
  const subtitleLink = document.querySelector(
    'a[data-track-component="focused_lex_download_subtitle"]'
  );

  if (subtitleLink) {
    const clickValue = subtitleLink.getAttribute("data-click-value");

    if (clickValue) {
      try {
        const parsed = JSON.parse(clickValue);

        if (parsed.languageCode) {
          return normalizeLanguageCode(parsed.languageCode);
        }
      } catch (e) {
        // Ignore parse errors.
      }
    }

    const download = subtitleLink.getAttribute("download") || "";
    const match = download.match(/subtitles-(\w+)\.vtt/i);

    if (match) {
      return normalizeLanguageCode(match[1]);
    }
  }

  const downloadLinks = document.querySelectorAll("a[download]");

  for (const link of downloadLinks) {
    const download = link.getAttribute("download") || "";
    const match = download.match(/subtitles-(\w+)\.vtt/i);

    if (match) {
      return normalizeLanguageCode(match[1]);
    }
  }

  return null;
}

async function fetchVttContent(url) {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download VTT file (HTTP ${response.status}).`);
  }

  return response.text();
}

function parseVtt(vttText) {
  const cues = [];
  const blocks = vttText.trim().split(/\n\s*\n/);

  for (const block of blocks) {
    const lines = block.trim().split("\n");
    let timestampLineIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("-->")) {
        timestampLineIndex = i;
        break;
      }
    }

    if (timestampLineIndex === -1) {
      continue;
    }

    const timestampLine = lines[timestampLineIndex];
    const match = timestampLine.match(
      /(\d{2}:\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}[.,]\d{3})/
    );

    if (!match) {
      continue;
    }

    const startTime = parseVttTimestamp(match[1]);
    const endTime = parseVttTimestamp(match[2]);
    const textLines = lines.slice(timestampLineIndex + 1);
    const text = textLines
      .join(" ")
      .replace(/<[^>]+>/g, "")
      .trim();

    if (!text) {
      continue;
    }

    cues.push({
      index: cues.length,
      startTime,
      endTime,
      text
    });
  }

  return cues;
}

function parseVttTimestamp(timestamp) {
  const cleaned = timestamp.replace(",", ".");
  const parts = cleaned.split(":");

  if (parts.length === 3) {
    return (
      parseFloat(parts[0]) * 3600 +
      parseFloat(parts[1]) * 60 +
      parseFloat(parts[2])
    );
  }

  if (parts.length === 2) {
    return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  }

  return parseFloat(cleaned);
}

function buildSemanticGroups(parsedCues) {
  if (!parsedCues.length) {
    return [];
  }

  const groups = [];
  let groupStart = 0;
  let groupParts = [];
  let groupChars = 0;

  for (let i = 0; i < parsedCues.length; i++) {
    const cue = parsedCues[i];
    const text = normalizeCueText(cue.text);
    groupParts.push(text);
    groupChars += text.length + 1;

    const isLast = i === parsedCues.length - 1;

    if (isLast) {
      finishGroup(groups, groupStart, i, groupParts);
      break;
    }

    const nextCue = parsedCues[i + 1];
    const hasTimestampGap =
      nextCue.startTime - cue.endTime >= TIMESTAMP_GAP_THRESHOLD_SEC;
    const currentEndsSentence = /[.!?]["')\]]?\s*$/.test(text);
    const nextText = normalizeCueText(nextCue.text);
    const nextStartsNewSentence = /^["'([{]?[A-Z]/.test(nextText);
    const atSentenceBoundary = currentEndsSentence && nextStartsNewSentence;

    if (hasTimestampGap) {
      finishGroup(groups, groupStart, i, groupParts);
      groupStart = i + 1;
      groupParts = [];
      groupChars = 0;
      continue;
    }

    if (atSentenceBoundary && groupChars >= MIN_SEMANTIC_GROUP_CHARS) {
      finishGroup(groups, groupStart, i, groupParts);
      groupStart = i + 1;
      groupParts = [];
      groupChars = 0;
      continue;
    }

    if (groupChars >= MAX_SEMANTIC_GROUP_CHARS && currentEndsSentence) {
      finishGroup(groups, groupStart, i, groupParts);
      groupStart = i + 1;
      groupParts = [];
      groupChars = 0;
      continue;
    }

    if (groupChars >= MAX_SEMANTIC_GROUP_CHARS * 1.5) {
      finishGroup(groups, groupStart, i, groupParts);
      groupStart = i + 1;
      groupParts = [];
      groupChars = 0;
    }
  }

  return groups;
}

function finishGroup(groups, start, end, parts) {
  const merged = parts
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();

  if (merged) {
    groups.push({ start, end, text: merged });
  }
}

async function applyTranslationsToVideo(parsedCues, groups, translations) {
  const cueTranslationMap = new Map();

  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const translatedText =
      translations[i] && translations[i].trim()
        ? translations[i]
        : group.text;
    const formatted = formatCueText(translatedText);

    for (let cueIdx = group.start; cueIdx <= group.end; cueIdx++) {
      cueTranslationMap.set(cueIdx, formatted);
    }
  }

  const video = document.querySelector("video");

  if (!video) {
    throw new Error("Video element not found on the page.");
  }

  const textTrack = await findMatchingTextTrack(video, parsedCues);

  if (!textTrack) {
    throw new Error(
      "Could not find a matching subtitle track on the video player."
    );
  }

  textTrack.mode = "showing";

  const trackCues = await loadTextTrackCues(textTrack);

  if (!trackCues.length) {
    throw new Error("Video subtitle track has no cues to update.");
  }

  for (const trackCue of trackCues) {
    const matchedIndex = findMatchingParsedCueIndex(
      parsedCues,
      trackCue.startTime,
      trackCue.endTime
    );

    if (matchedIndex !== null && cueTranslationMap.has(matchedIndex)) {
      trackCue.text = cueTranslationMap.get(matchedIndex);
    }
  }
}

function findMatchingParsedCueIndex(parsedCues, startTime, endTime) {
  const tolerance = 0.15;

  for (let i = 0; i < parsedCues.length; i++) {
    if (
      Math.abs(parsedCues[i].startTime - startTime) < tolerance &&
      Math.abs(parsedCues[i].endTime - endTime) < tolerance
    ) {
      return i;
    }
  }

  for (let i = 0; i < parsedCues.length; i++) {
    if (Math.abs(parsedCues[i].startTime - startTime) < tolerance) {
      return i;
    }
  }

  return null;
}

async function findMatchingTextTrack(video, parsedCues) {
  const tracks = Array.from(video.textTracks || []);
  const subtitleTracks = tracks.filter((track) => {
    const kind = (track.kind || "").toLowerCase();
    return !kind || kind === "subtitles" || kind === "captions";
  });

  for (const track of subtitleTracks) {
    const originalMode = track.mode;

    if (track.mode === "disabled") {
      track.mode = "hidden";
    }

    const cues = await loadTextTrackCues(track);

    if (cues.length === parsedCues.length) {
      const firstMatch =
        cues.length > 0 &&
        Math.abs(cues[0].startTime - parsedCues[0].startTime) < 0.2;
      const lastMatch =
        cues.length > 0 &&
        Math.abs(
          cues[cues.length - 1].startTime -
            parsedCues[parsedCues.length - 1].startTime
        ) < 0.2;

      if (firstMatch && lastMatch) {
        return track;
      }
    }

    if (track.mode !== originalMode) {
      track.mode = originalMode;
    }
  }

  for (const track of subtitleTracks) {
    if (track.mode === "disabled") {
      track.mode = "hidden";
    }

    const cues = await loadTextTrackCues(track);

    if (cues.length > 0) {
      return track;
    }
  }

  return null;
}

async function loadTextTrackCues(textTrack) {
  let cues = Array.from(textTrack.cues || []);

  for (let i = 0; i < TRACK_CUE_LOAD_ATTEMPTS && !cues.length; i++) {
    await sleep(TRACK_CUE_LOAD_INTERVAL_MS);
    cues = Array.from(textTrack.cues || []);
  }

  return cues;
}

function isTranslationAppliedForCurrentVideo() {
  if (!translatedVideoKey) {
    return false;
  }

  return translatedVideoKey.startsWith(location.pathname);
}

function buildVideoKeyFromVtt(vttUrl, parsedCues) {
  const firstCue = parsedCues[0]
    ? `${parsedCues[0].startTime}-${parsedCues[0].endTime}`
    : "none";
  const lastCue = parsedCues[parsedCues.length - 1]
    ? `${parsedCues[parsedCues.length - 1].startTime}-${parsedCues[parsedCues.length - 1].endTime}`
    : "none";

  const urlPart = vttUrl.replace(/[?#].*$/, "").split("/").pop() || "";
  return `${location.pathname}|${urlPart}|${parsedCues.length}|${firstCue}|${lastCue}`;
}

function requestTranslations(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "translateSubtitles", payload },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error("Failed to connect to background script."));
          return;
        }

        if (!response || !response.ok) {
          reject(
            new Error(
              (response && response.error) ||
                "Translation service request failed."
            )
          );
          return;
        }

        if (!Array.isArray(response.translations)) {
          reject(new Error("Translation response format is invalid."));
          return;
        }

        resolve(response);
      }
    );
  });
}

function normalizeCueText(text) {
  const decoded = decodeHtml(text || "");
  return decoded.replace(/\s+/g, " ").trim();
}

function decodeHtml(text) {
  const parser = document.createElement("textarea");
  parser.innerHTML = text;
  return parser.value;
}

function normalizeLanguageCode(languageCode) {
  return String(languageCode || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
}

function getLanguageBase(languageCode) {
  const normalized = normalizeLanguageCode(languageCode);

  if (!normalized) {
    return "";
  }

  return normalized.split("-")[0];
}

function formatCueText(text) {
  const clean = (text || "").replace(/\s+/g, " ").trim();

  if (!clean) {
    return "";
  }

  if (clean.length <= MAX_LINE_LENGTH) {
    return clean;
  }

  const midpoint = Math.floor(clean.length / 2);
  const minSplit = Math.max(22, Math.floor(clean.length * 0.35));
  const maxSplit = Math.min(clean.length - 12, Math.floor(clean.length * 0.65));
  let splitIndex = -1;

  for (let offset = 0; offset < clean.length; offset++) {
    const right = midpoint + offset;

    if (right >= minSplit && right <= maxSplit && clean[right] === " ") {
      splitIndex = right;
      break;
    }

    const left = midpoint - offset;

    if (left >= minSplit && left <= maxSplit && clean[left] === " ") {
      splitIndex = left;
      break;
    }
  }

  if (splitIndex === -1) {
    splitIndex = clean.lastIndexOf(" ", MAX_LINE_LENGTH);
  }

  if (splitIndex === -1) {
    splitIndex = clean.indexOf(" ", MAX_LINE_LENGTH);
  }

  if (splitIndex === -1) {
    return clean;
  }

  const firstLine = clean.slice(0, splitIndex).trim();
  const secondLine = clean.slice(splitIndex + 1).trim();
  return `${firstLine}\n${secondLine}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
