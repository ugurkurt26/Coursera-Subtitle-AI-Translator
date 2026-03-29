const DEFAULT_TARGET_LANGUAGE = "tr";
const DEFAULT_SOURCE_LANGUAGE = "en";
const AI_TRACK_SELECTOR = 'track[data-ai-subtitle-track="true"]';
const AI_MENU_OPTION_SELECTOR = '[data-ai-subtitle-option="true"]';
const AI_MENU_STYLE_ID = "ai-subtitle-menu-style";
const MAX_LINE_LENGTH = 56;
const MAX_SEMANTIC_GROUP_CHARS = 500;
const MIN_SEMANTIC_GROUP_CHARS = 80;
const TIMESTAMP_GAP_THRESHOLD_SEC = 1.5;
const TRACK_CUE_LOAD_ATTEMPTS = 5;
const TRACK_CUE_LOAD_INTERVAL_MS = 140;

let translatedVideoKey = null;
let translationInProgress = false;
let activeTranslationSession = null;
let subtitleMenuSyncScheduled = false;
let subtitleMenuSyncInProgress = false;
let subtitleMenuClickBound = false;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || !request.type) {
    return;
  }

  if (request.type === "translateCurrentVideo") {
    const targetLanguage = request.targetLanguage || DEFAULT_TARGET_LANGUAGE;
    const provider = request.provider || "gemini";
    const model = request.model || "";
    const apiKey = request.apiKey || "";

    translateCurrentVideo({ targetLanguage, provider, model, apiKey })
      .then(() => {
        sendResponse({ ok: true });
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

async function translateCurrentVideo(options) {
  const targetLanguage = options && options.targetLanguage ? options.targetLanguage : DEFAULT_TARGET_LANGUAGE;
  const provider = options && options.provider ? options.provider : "gemini";
  const model = options && options.model ? options.model : "";
  const apiKey = options && options.apiKey ? options.apiKey : "";

  if (translationInProgress) {
    throw new Error("Translation is already in progress.");
  }

  const selectedVtt = selectVttCandidate();
  const vttUrl = selectedVtt && selectedVtt.url ? selectedVtt.url : "";

  if (!vttUrl) {
    throw new Error("VTT subtitle download link not found on this page. Make sure the Downloads section is visible.");
  }

  const sourceLanguage = DEFAULT_SOURCE_LANGUAGE;
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

  if (
    activeTranslationSession &&
    activeTranslationSession.pagePath === location.pathname &&
    activeTranslationSession.videoKey === videoKey &&
    activeTranslationSession.targetLanguage === targetLanguage
  ) {
    throw new Error("Translation has already been applied for this video.");
  }

  translationInProgress = true;

  try {
    const groups = buildSemanticGroups(parsedCues);
    const segments = groups.map((group) => group.text);

    const response = await requestTranslations({
      segments,
      sourceLanguage,
      targetLanguage,
      provider,
      model,
      apiKey
    });

    const translations = response.translations;

    await applyTranslationsToVideo(parsedCues, groups, translations, targetLanguage, videoKey);

    translatedVideoKey = videoKey;

    return;
  } finally {
    translationInProgress = false;
  }
}

function selectVttCandidate() {
  const candidates = collectVttCandidates();

  if (!candidates.length) {
    return null;
  }

  const preferredLanguage = DEFAULT_SOURCE_LANGUAGE;

  candidates.sort((a, b) => scoreVttCandidate(b, preferredLanguage) - scoreVttCandidate(a, preferredLanguage));
  return candidates[0];
}

function collectVttCandidates() {
  const candidateMap = new Map();

  const focusedLink = document.querySelector('a[data-track-component="focused_lex_download_subtitle"]');

  if (focusedLink && focusedLink.href) {
    addVttCandidate(candidateMap, {
      url: focusedLink.href,
      fileName: focusedLink.getAttribute("download") || "",
      language: extractLanguageFromElement(focusedLink),
      label: extractCandidateLabelFromElement(focusedLink),
      source: "focused"
    });
  }

  const downloadLinks = document.querySelectorAll("a[download]");

  for (const link of downloadLinks) {
    const download = (link.getAttribute("download") || "").toLowerCase();

    if (download.endsWith(".vtt") && link.href) {
      addVttCandidate(candidateMap, {
        url: link.href,
        fileName: link.getAttribute("download") || "",
        language: extractLanguageFromElement(link),
        label: extractCandidateLabelFromElement(link),
        source: "download"
      });
    }
  }

  const proxyLinks = document.querySelectorAll('a[href*="subtitleAssetProxy"]');

  for (const link of proxyLinks) {
    if (link.href && /fileExtension=vtt/i.test(link.href)) {
      addVttCandidate(candidateMap, {
        url: link.href,
        fileName: link.getAttribute("download") || "",
        language: extractLanguageFromElement(link),
        label: extractCandidateLabelFromElement(link),
        source: "proxy"
      });
    }
  }

  const trackElements = document.querySelectorAll("video track[src]");

  for (const track of trackElements) {
    const kind = (track.kind || "").toLowerCase();

    if (kind && kind !== "subtitles" && kind !== "captions") {
      continue;
    }

    if (track.src) {
      addVttCandidate(candidateMap, {
        url: track.src,
        fileName: track.getAttribute("src") || "",
        language: normalizeLanguageCode(track.srclang || ""),
        label: track.label || "",
        source: "track"
      });
    }
  }

  return Array.from(candidateMap.values());
}

function addVttCandidate(candidateMap, candidate) {
  if (!candidate || !candidate.url) {
    return;
  }

  const normalizedLanguage = normalizeLanguageCode(candidate.language || extractLanguageFromFileName(candidate.fileName) || extractLanguageFromUrl(candidate.url));
  const fileName = resolveVttFileName(candidate.fileName || candidate.url);
  const label = String(candidate.label || "").trim();
  const isAutoTranslated = looksLikeAutoTranslatedLabel(label) || looksLikeAutoTranslatedLabel(fileName);

  const key = candidate.url;
  const existing = candidateMap.get(key);

  if (!existing) {
    candidateMap.set(key, {
      url: candidate.url,
      fileName,
      language: normalizedLanguage || "",
      label,
      isAutoTranslated,
      source: candidate.source || "unknown"
    });
  }
}

function resolvePreferredSourceLanguage(candidates) {
  const languageScores = new Map();
  let hasNonFocusedLanguage = false;
  let hasNonAutoLanguage = false;

  for (const candidate of candidates) {
    const language = normalizeLanguageCode(candidate.language);

    if (!language) {
      continue;
    }

    if (candidate.source !== "focused") {
      hasNonFocusedLanguage = true;
    }

    if (!candidate.isAutoTranslated) {
      hasNonAutoLanguage = true;
    }
  }

  for (const candidate of candidates) {
    const language = normalizeLanguageCode(candidate.language);

    if (!language) {
      continue;
    }

    if (hasNonFocusedLanguage && candidate.source === "focused") {
      continue;
    }

    if (hasNonAutoLanguage && candidate.isAutoTranslated) {
      continue;
    }

    languageScores.set(language, (languageScores.get(language) || 0) + getCandidateSourceWeight(candidate.source));
  }

  let bestLanguage = "";
  let bestScore = -1;

  for (const [language, score] of languageScores.entries()) {
    if (score > bestScore) {
      bestLanguage = language;
      bestScore = score;
    }
  }

  return bestLanguage;
}

function scoreVttCandidate(candidate, preferredLanguage) {
  let score = 0;
  const language = normalizeLanguageCode(candidate.language);
  const fileName = String(candidate.fileName || "").toLowerCase();
  const url = String(candidate.url || "");
  const urlLanguage = extractLanguageFromUrl(url);
  const fileLanguage = extractLanguageFromFileName(fileName);

  score += getCandidateSourceWeight(candidate.source) * 10;

  if (candidate.isAutoTranslated) {
    score -= 80;
  } else if (candidate.label) {
    score += 40;
  }

  if (language) {
    score += 20;
  }

  if (preferredLanguage) {
    if (language === preferredLanguage) {
      score += 140;
    } else if (getLanguageBase(language) && getLanguageBase(language) === getLanguageBase(preferredLanguage)) {
      score += 60;
    }
  }

  if (fileLanguage && language && fileLanguage === language) {
    score += 20;
  }

  if (urlLanguage && language && urlLanguage === language) {
    score += 20;
  }

  if (fileLanguage === preferredLanguage) {
    score += 120;
  }

  if (urlLanguage === preferredLanguage) {
    score += 120;
  }

  if (/subtitles-[a-z-]+\.vtt/i.test(fileName)) {
    score += 10;
  }

  return score;
}

function getCandidateSourceWeight(source) {
  if (source === "track") {
    return 5;
  }

  if (source === "download") {
    return 4;
  }

  if (source === "proxy") {
    return 3;
  }

  if (source === "focused") {
    return 1;
  }

  return 1;
}

function extractLanguageFromElement(element) {
  if (!element) {
    return "";
  }

  const clickValue = element.getAttribute("data-click-value");

  if (clickValue) {
    try {
      const parsed = JSON.parse(clickValue);

      if (parsed.languageCode) {
        return normalizeLanguageCode(parsed.languageCode);
      }
    } catch (_) {
      // Ignore parse errors.
    }
  }

  return extractLanguageFromFileName(element.getAttribute("download") || "") || "";
}

function extractCandidateLabelFromElement(element) {
  if (!element) {
    return "";
  }

  return String(
    element.getAttribute("aria-label") ||
    element.getAttribute("title") ||
    element.textContent ||
    ""
  ).replace(/\s+/g, " ").trim();
}

function looksLikeAutoTranslatedLabel(value) {
  const normalized = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  if (!normalized) {
    return false;
  }

  const tokens = normalized.match(/[a-z.]+/g) || [];
  return tokens.some((token) =>
    token === "aut" ||
    token === "aut." ||
    token === "auto" ||
    token.startsWith("auto") ||
    token.startsWith("otom")
  );
}

function extractLanguageFromFileName(value) {
  const match = String(value || "").match(/subtitles-([a-z0-9_-]+)\.vtt/i);
  return match ? normalizeLanguageCode(match[1]) : "";
}

function extractLanguageFromUrl(value) {
  const input = String(value || "");
  const match =
    input.match(/[?&](?:language|languageCode|lang)=([a-z0-9_-]+)/i) ||
    input.match(/subtitles-([a-z0-9_-]+)\.vtt/i);

  return match ? normalizeLanguageCode(match[1]) : "";
}

function resolveVttFileName(value) {
  const input = String(value || "");
  const cleaned = input.replace(/[?#].*$/, "");
  const parts = cleaned.split("/");
  return parts[parts.length - 1] || input;
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

async function applyTranslationsToVideo(parsedCues, groups, translations, targetLanguage, videoKey) {
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

  const trackState = await upsertAiSubtitleTrack(video, parsedCues, cueTranslationMap, targetLanguage, videoKey);

  activeTranslationSession = {
    videoKey,
    pagePath: location.pathname,
    targetLanguage,
    trackElement: trackState.trackElement,
    blobUrl: trackState.blobUrl
  };
  ensureAiSubtitleMenuOption();
}

function getSubtitleTracks(video) {
  const tracks = Array.from((video && video.textTracks) || []);
  return tracks.filter((track) => {
    const kind = (track.kind || "").toLowerCase();
    return !kind || kind === "subtitles" || kind === "captions";
  });
}

function isTranslationAppliedForCurrentVideo() {
  if (!translatedVideoKey || !activeTranslationSession) {
    return false;
  }

  return (
    translatedVideoKey.startsWith(location.pathname) &&
    activeTranslationSession.pagePath === location.pathname &&
    !!activeTranslationSession.trackElement &&
    activeTranslationSession.trackElement.isConnected
  );
}

async function upsertAiSubtitleTrack(video, parsedCues, cueTranslationMap, targetLanguage, videoKey) {
  const trackElement = getOrCreateAiTrackElement(video);
  const blobUrl = URL.createObjectURL(
    new Blob([buildTranslatedVtt(parsedCues, cueTranslationMap)], { type: "text/vtt" })
  );

  cleanupActiveAiTrack();

  trackElement.kind = "subtitles";
  trackElement.label = buildAiTrackLabel(targetLanguage);
  trackElement.srclang = getLanguageBase(targetLanguage) || targetLanguage || DEFAULT_TARGET_LANGUAGE;
  trackElement.default = false;
  trackElement.dataset.aiSubtitleTrack = "true";
  trackElement.dataset.videoKey = videoKey;
  trackElement.src = blobUrl;

  await waitForTrackElementLoad(trackElement);
  showOnlySubtitleTrack(video, trackElement.track);

  return { trackElement, blobUrl };
}

function getOrCreateAiTrackElement(video) {
  let trackElement = video.querySelector(AI_TRACK_SELECTOR);

  if (!trackElement) {
    trackElement = document.createElement("track");
    video.appendChild(trackElement);
  }

  return trackElement;
}

function cleanupActiveAiTrack() {
  if (!activeTranslationSession) {
    return;
  }

  if (activeTranslationSession.blobUrl) {
    URL.revokeObjectURL(activeTranslationSession.blobUrl);
  }
}

function showOnlySubtitleTrack(video, selectedTrack) {
  const subtitleTracks = getSubtitleTracks(video);

  for (const track of subtitleTracks) {
    track.mode = track === selectedTrack ? "showing" : "disabled";
  }
}

function buildTranslatedVtt(parsedCues, cueTranslationMap) {
  const blocks = ["WEBVTT"];

  for (const cue of parsedCues) {
    const translatedText = cueTranslationMap.get(cue.index) || cue.text;
    blocks.push(
      "",
      String(cue.index + 1),
      `${formatVttTimestamp(cue.startTime)} --> ${formatVttTimestamp(cue.endTime)}`,
      translatedText
    );
  }

  return blocks.join("\n");
}

function formatVttTimestamp(seconds) {
  const totalMs = Math.max(0, Math.round(Number(seconds || 0) * 1000));
  const hours = Math.floor(totalMs / 3600000);
  const minutes = Math.floor((totalMs % 3600000) / 60000);
  const secs = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;

  return [
    String(hours).padStart(2, "0"),
    String(minutes).padStart(2, "0"),
    String(secs).padStart(2, "0")
  ].join(":") + "." + String(ms).padStart(3, "0");
}

function buildAiTrackLabel(targetLanguage) {
  return `${resolveLanguageLabel(targetLanguage)} (AI)`;
}

function showAiSubtitleTrack() {
  if (!activeTranslationSession || !activeTranslationSession.trackElement || !activeTranslationSession.trackElement.track) {
    return;
  }

  const video = document.querySelector("video");

  if (!video) {
    return;
  }

  showOnlySubtitleTrack(video, activeTranslationSession.trackElement.track);
  syncAiSubtitleMenuOption();
}

function ensureAiSubtitleMenuOption() {
  if (!document.body) {
    return;
  }

  ensureAiSubtitleMenuStyles();

  if (!subtitleMenuClickBound) {
    subtitleMenuClickBound = true;
    document.addEventListener("click", scheduleAiSubtitleMenuSync, true);
  }

  scheduleAiSubtitleMenuSync();
}

function scheduleAiSubtitleMenuSync() {
  if (subtitleMenuSyncScheduled) {
    return;
  }

  subtitleMenuSyncScheduled = true;
  setTimeout(() => {
    subtitleMenuSyncScheduled = false;
    syncAiSubtitleMenuOption();
  }, 0);
}

function syncAiSubtitleMenuOption() {
  if (!activeTranslationSession || subtitleMenuSyncInProgress) {
    return;
  }

  subtitleMenuSyncInProgress = true;

  try {
  const offOption = findSubtitleOffMenuOption();

  if (!offOption || !offOption.parentElement) {
    return;
  }

  const container = offOption.parentElement;
  const isSelected =
    !!activeTranslationSession.trackElement &&
    !!activeTranslationSession.trackElement.track &&
    activeTranslationSession.trackElement.track.mode === "showing";
  const templates = resolveMenuTemplateOptions(container, offOption);
  const templateOption = templates.unselected;
  let aiOption = container.querySelector(AI_MENU_OPTION_SELECTOR);

  if (!aiOption) {
    aiOption = createAiSubtitleMenuOption(templateOption, templates, isSelected);
    offOption.insertAdjacentElement("afterend", aiOption);
  } else {
    updateAiSubtitleMenuOption(aiOption, templateOption, templates, isSelected);
  }

  setNativeMenuTickVisibility(container, isSelected);
  bindNativeSubtitleMenuOptionHandlers(container, aiOption);
  } finally {
    subtitleMenuSyncInProgress = false;
  }
}

function findSubtitleOffMenuOption() {
  const candidates = Array.from(document.querySelectorAll("button,[role='menuitemradio'],[role='menuitem'],li,div"));

  for (const candidate of candidates) {
    const text = normalizeMenuText(candidate.textContent);

    if (text === "subtitles off") {
      return candidate;
    }
  }

  return null;
}

function createAiSubtitleMenuOption(referenceOption, templates, isSelected) {
  const option = document.createElement("button");
  option.type = "button";
  option.dataset.aiSubtitleOption = "true";
  attachAiSubtitleMenuOptionHandler(option);
  applyAiMenuOptionState(option, templates, isSelected);
  return option;
}

function resolveMenuTemplateOptions(container, fallbackOption) {
  if (!container) {
    return { selected: fallbackOption, unselected: fallbackOption };
  }

  const options = Array.from(container.children || []).filter(
    (child) => child && child.dataset.aiSubtitleOption !== "true"
  );
  const selectedOption = options.find((child) => child.getAttribute("aria-selected") === "true") || fallbackOption;
  const unselectedOption = options.find((child) => child.getAttribute("aria-selected") !== "true") || fallbackOption;

  return {
    selected: selectedOption || fallbackOption,
    unselected: unselectedOption || fallbackOption
  };
}

function updateAiSubtitleMenuOption(option, referenceOption, templates, isSelected) {
  if (!option || !referenceOption) {
    return;
  }

  option.dataset.aiSubtitleOption = "true";
  applyAiMenuOptionState(option, templates, isSelected);
  attachAiSubtitleMenuOptionHandler(option);
}

function attachAiSubtitleMenuOptionHandler(option) {
  if (!option || option.dataset.aiSubtitleBound === "true") {
    return;
  }

  option.dataset.aiSubtitleBound = "true";
  option.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    showAiSubtitleTrack();
  });
}

function bindNativeSubtitleMenuOptionHandlers(container, aiOption) {
  const options = Array.from(container.children || []);

  for (const option of options) {
    if (!option || option === aiOption || option.dataset.aiSubtitleNativeBound === "true") {
      continue;
    }

    option.dataset.aiSubtitleNativeBound = "true";
    option.addEventListener("click", () => {
      hideAiSubtitleTrack();
    });
  }
}

function setNativeMenuTickVisibility(container, hideTicks) {
  if (!container) {
    return;
  }

  if (hideTicks) {
    container.dataset.aiSubtitleActive = "true";
    return;
  }

  delete container.dataset.aiSubtitleActive;
}

function hideAiSubtitleTrack() {
  if (!activeTranslationSession || !activeTranslationSession.trackElement || !activeTranslationSession.trackElement.track) {
    return;
  }

  activeTranslationSession.trackElement.track.mode = "disabled";
  scheduleAiSubtitleMenuSync();
}

function setMenuOptionSelected(option, isSelected) {
  if (!option) {
    return;
  }

  option.dataset.aiSubtitleSelected = isSelected ? "true" : "false";
  option.setAttribute("aria-pressed", isSelected ? "true" : "false");
}

function setMenuOptionLabel(option, label) {
  if (!option) {
    return;
  }

  let labelNode = option.querySelector("[data-ai-subtitle-label]");

  if (!labelNode) {
    labelNode = getMenuOptionLabelContainer(option);

    if (labelNode) {
      labelNode.dataset.aiSubtitleLabel = "true";
      labelNode.textContent = label;
    } else {
      option.textContent = label;
    }
  } else {
    labelNode.textContent = label;
  }

  const isSelected = option.getAttribute("aria-pressed") === "true";
  option.setAttribute("aria-label", buildMenuOptionAriaLabel(label, isSelected));
}

function applyAiMenuOptionState(option, templates, isSelected) {
  if (!option || !templates) {
    return;
  }

  const selectedTemplate = templates.selected || templates.unselected || option;
  const unselectedTemplate = templates.unselected || templates.selected || option;
  const visualTemplate = isSelected ? selectedTemplate : unselectedTemplate;

  option.className = visualTemplate.className || "";
  option.tabIndex = 0;
  syncMenuOptionStructure(option, visualTemplate);
  setMenuOptionSelected(option, isSelected);
  setMenuOptionLabel(option, buildAiTrackLabel(activeTranslationSession ? activeTranslationSession.targetLanguage : DEFAULT_TARGET_LANGUAGE));
}

function syncMenuOptionStructure(option, template) {
  if (!option || !template) {
    return;
  }

  if (option.childElementCount === 0) {
    option.appendChild(document.createElement("div"));
    option.appendChild(document.createElement("div"));
  }

  const optionIcon = getMenuOptionIconContainer(option);
  const templateIcon = getMenuOptionIconContainer(template);

  if (optionIcon && templateIcon) {
    optionIcon.className = templateIcon.className;
    optionIcon.innerHTML = templateIcon.innerHTML;
    removeDuplicateIds(optionIcon);
  }

  const optionLabel = getMenuOptionLabelContainer(option);
  const templateLabel = getMenuOptionLabelContainer(template);

  if (optionLabel && templateLabel) {
    optionLabel.className = templateLabel.className;
  }
}

function getMenuOptionIconContainer(option) {
  return option ? option.querySelector("div:first-child") : null;
}

function getMenuOptionLabelContainer(option) {
  return option ? option.querySelector("div:last-child") : null;
}

function getMenuOptionLabelText(option) {
  const labelContainer = getMenuOptionLabelContainer(option);
  return normalizeMenuText(labelContainer ? labelContainer.textContent : option ? option.textContent : "");
}

function buildMenuOptionAriaLabel(label, isSelected) {
  const text = String(label || "").trim();
  return isSelected ? `${text} active` : text;
}

function ensureAiSubtitleMenuStyles() {
  if (document.getElementById(AI_MENU_STYLE_ID)) {
    return;
  }

  const style = document.createElement("style");
  style.id = AI_MENU_STYLE_ID;
  style.textContent = `
    [role="menu"][data-ai-subtitle-active="true"] > [data-ai-subtitle-native-bound="true"] > div:first-child svg {
      opacity: 0;
    }
  `;
  document.head.appendChild(style);
}

function removeDuplicateIds(root) {
  if (!root || typeof root.querySelectorAll !== "function") {
    return;
  }

  for (const node of root.querySelectorAll("[id]")) {
    node.removeAttribute("id");
  }
}

function normalizeMenuText(text) {
  return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function resolveLanguageLabel(languageCode) {
  const labels = {
    tr: "Türkçe",
    en: "English",
    es: "Español",
    fr: "Français",
    de: "Deutsch",
    pt: "Português",
    it: "Italiano",
    ar: "العربية",
    ru: "Русский",
    ja: "日本語",
    ko: "한국어",
    zh: "中文",
    hi: "Hindi",
    id: "Bahasa Indonesia"
  };

  return labels[getLanguageBase(languageCode)] || String(languageCode || "").toUpperCase() || "Subtitle";
}

async function waitForTrackElementLoad(trackElement) {
  if (!trackElement) {
    throw new Error("AI subtitle track could not be created.");
  }

  if (trackElement.readyState === 2) {
    return;
  }

  await new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      cleanup();
      resolve();
    }, TRACK_CUE_LOAD_ATTEMPTS * TRACK_CUE_LOAD_INTERVAL_MS);

    const handleLoad = () => {
      cleanup();
      resolve();
    };

    const handleError = () => {
      cleanup();
      reject(new Error("AI subtitle track could not be loaded."));
    };

    const cleanup = () => {
      clearTimeout(timeoutId);
      trackElement.removeEventListener("load", handleLoad);
      trackElement.removeEventListener("error", handleError);
    };

    trackElement.addEventListener("load", handleLoad);
    trackElement.addEventListener("error", handleError);
  });
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
  const normalized = String(languageCode || "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");

  if (!normalized) {
    return "";
  }

  if (normalized === "auto") {
    return "";
  }

  if (!/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(normalized)) {
    return "";
  }

  return normalized;
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
