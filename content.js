const DEFAULT_TARGET_LANGUAGE = "tr";
const MAX_LINE_LENGTH = 56;
const MAX_GROUP_CHARS = 170;

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
    sendResponse({ ok: true, applied: isTranslationAppliedForCurrentVideo(), inProgress: translationInProgress });
  }
});

async function translateCurrentVideo(targetLanguage) {
  const englishTrack = findTrackByLang("en");
  if (!englishTrack) {
    throw new Error("English subtitle track was not found for this video.");
  }

  englishTrack.track.mode = "showing";
  await sleep(400);

  const cues = Array.from(englishTrack.track.cues || []);
  if (!cues.length) {
    throw new Error("Subtitle cue list is empty.");
  }

  const videoKey = buildVideoKey(englishTrack, cues);
  if (translatedVideoKey && translatedVideoKey === videoKey) {
    throw new Error("Translation has already been applied for this video.");
  }

  if (translationInProgress) {
    throw new Error("Translation is already in progress.");
  }

  translationInProgress = true;

  try {
    const groups = buildSentenceGroups(cues);
    const segments = groups.map((group) => group.text);

    const response = await requestTranslations({
      segments,
      sourceLanguage: "en",
      targetLanguage
    });

    const translations = response.translations;
    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const translatedText = translations[i] && translations[i].trim() ? translations[i] : group.text;
      const formatted = formatCueText(translatedText);

      for (let cueIndex = group.start; cueIndex <= group.end; cueIndex++) {
        cues[cueIndex].text = formatted;
      }
    }

    translatedVideoKey = videoKey;

    return {
      translatedCount: cues.length,
      groupCount: groups.length,
      mode: response.mode || "single"
    };
  } finally {
    translationInProgress = false;
  }
}

function findTrackByLang(languageCode) {
  const tracks = Array.from(document.getElementsByTagName("track"));
  return tracks.find((track) => {
    const lang = (track.srclang || "").toLowerCase();
    return lang === languageCode || lang.startsWith(languageCode + "-");
  });
}

function isTranslationAppliedForCurrentVideo() {
  const englishTrack = findTrackByLang("en");
  if (!englishTrack || !englishTrack.track) {
    return false;
  }

  const cues = Array.from(englishTrack.track.cues || []);
  if (!cues.length) {
    return false;
  }

  return translatedVideoKey === buildVideoKey(englishTrack, cues);
}

function buildVideoKey(track, cues) {
  const trackSource = track.src || "inline-track";
  const firstCue = cues[0] ? `${cues[0].startTime}-${cues[0].endTime}` : "none";
  const lastCue = cues[cues.length - 1] ? `${cues[cues.length - 1].startTime}-${cues[cues.length - 1].endTime}` : "none";
  return `${location.pathname}|${trackSource}|${cues.length}|${firstCue}|${lastCue}`;
}

function buildSentenceGroups(cues) {
  const normalized = cues.map((cue) => normalizeCueText(cue.text));
  const groups = [];

  let groupStart = 0;
  let groupParts = [];
  let groupChars = 0;

  for (let i = 0; i < normalized.length; i++) {
    const currentText = normalized[i] || "";
    groupParts.push(currentText);
    groupChars += currentText.length + 1;

    const nextText = i + 1 < normalized.length ? normalized[i + 1] : "";
    const isLast = i === normalized.length - 1;
    const sentenceBoundary = isSentenceBoundary(currentText, nextText);
    const groupTooLong = groupChars >= MAX_GROUP_CHARS;

    if (isLast || sentenceBoundary || groupTooLong) {
      const merged = mergeGroupParts(groupParts);
      groups.push({
        start: groupStart,
        end: i,
        text: merged || currentText
      });

      groupStart = i + 1;
      groupParts = [];
      groupChars = 0;
    }
  }

  return groups;
}

function isSentenceBoundary(currentText, nextText) {
  if (!nextText) {
    return true;
  }

  const endsSentence = /[.!?]["')\]]?$/.test(currentText);
  const nextStartsSentence = /^["'([{]?[A-Z0-9]/.test(nextText);

  return endsSentence && nextStartsSentence;
}

function mergeGroupParts(parts) {
  return parts
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

function requestTranslations(payload) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: "translateSubtitles", payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error("Failed to connect to background script."));
        return;
      }

      if (!response || !response.ok) {
        reject(new Error((response && response.error) || "Translation service request failed."));
        return;
      }

      if (!Array.isArray(response.translations)) {
        reject(new Error("Translation response format is invalid."));
        return;
      }

      resolve(response);
    });
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
