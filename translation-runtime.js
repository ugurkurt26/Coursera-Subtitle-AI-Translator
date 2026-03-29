(() => {
function resolveBundledSource(name) {
  if (typeof chrome !== "undefined" && chrome.runtime && typeof chrome.runtime.getURL === "function") {
    return chrome.runtime.getURL(name);
  }

  return name;
}

// ── Configuration ──

const DEFAULT_PROVIDER_MODELS = {
  gemini: "gemini-3.1-flash-lite-preview",
  openai: "gpt-5.4-mini",
  anthropic: "claude-sonnet-4-20250514",
  deepseek: "deepseek-chat"
};
const DEFAULT_PROVIDER = "gemini";

const FULL_INPUT_TOKEN_LIMIT = 1048576;
const FULL_OUTPUT_TOKEN_LIMIT = 65536;
const FULL_INPUT_SAFE_LIMIT = Math.floor(FULL_INPUT_TOKEN_LIMIT * 0.9);
const FULL_OUTPUT_SAFE_LIMIT = Math.floor(FULL_OUTPUT_TOKEN_LIMIT * 0.85);

const CHUNK_CHAR_LIMIT = 8000;
const CHUNK_CONTEXT_WINDOW = 4;
const PARALLEL_CHUNK_CONCURRENCY = 2;
const SINGLE_REQUEST_INPUT_BUDGET = 1800;
const SINGLE_REQUEST_OUTPUT_BUDGET = 1200;
const SINGLE_REQUEST_SEGMENT_BUDGET = 25;

const DEFAULT_TERMS_SOURCE = resolveBundledSource("tech_terms_dictionary.json");
const DEFAULT_PROMPT_RULES_SOURCE = resolveBundledSource("prompt-rules.json");
const PROMPT_RULES_SOURCE = DEFAULT_PROMPT_RULES_SOURCE;
const UNICODE_DASH_REGEX = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const TECHNICAL_PHRASE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "this",
  "those",
  "to",
  "was",
  "were",
  "with"
]);
const TURKISH_RETRY_PROMPT_RULES = [
  "Translate the full segment into natural Turkish.",
  "Do not leave the whole segment unchanged in English unless the segment is entirely an immutable identifier, command, file path, or code snippet.",
  "Keep only clearly immutable technical tokens in English; translate the surrounding explanation fully into Turkish.",
  "Avoid introducing compounds or morphology from a non-target language."
];

// ── Language Map ──

const LANGUAGE_MAP = {
  auto: "Auto-detected source language",
  tr: "Turkish",
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  pt: "Portuguese",
  it: "Italian",
  ar: "Arabic",
  ru: "Russian",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  hi: "Hindi",
  id: "Indonesian"
};

// ── Runtime State ──

let termsSourceInfo = DEFAULT_TERMS_SOURCE;
let promptRulesInfo = PROMPT_RULES_SOURCE;
let alwaysProtectTerms = [];
let candidateTerms = [];
let candidateTermSet = new Set();
let candidatePhraseSet = new Set();
let candidateWordSet = new Set();
let candidateHeadWordSet = new Set();
let promptRulesConfig = null;

// ── Entry Point ──

let bootstrapPromise = null;

// ── Translation Pipeline ──

async function translateRequest(payload) {
  const segments = Array.isArray(payload && payload.segments) ? payload.segments : [];

  if (!segments.length) {
    throw new Error("segments array cannot be empty.");
  }

  const cleanedSegments = segments.map((item) => normalizeSegment(item));
  const indexedSegments = cleanedSegments.map((text, index) => ({ index, text }));

  const sourceLanguage = normalizeLanguage(payload && payload.sourceLanguage, "auto");
  const targetLanguage = normalizeLanguage(payload && payload.targetLanguage, "tr");
  const provider = normalizeProvider(payload && payload.provider);
  const model = resolveProviderModel(provider, payload && payload.model);
  const apiKey = resolveProviderApiKey(provider, payload && payload.apiKey);
  const protectedTerms = extractProtectedTerms(cleanedSegments, targetLanguage);
  const promptTerms = protectedTerms.slice(0, 90);
  const preparedSegments = prepareSegmentsForTranslation(indexedSegments, protectedTerms, targetLanguage);

  const fullPrompt = buildTranslationPrompt({
    sourceLanguage,
    targetLanguage,
    segments: preparedSegments,
    contextBefore: [],
    protectedTerms: promptTerms
  });

  const inputTokenCount = estimateInputTokens(fullPrompt);
  const estimatedOutputTokens = estimateOutputTokens(cleanedSegments);

  const shouldUseSingleRequest =
    inputTokenCount <= Math.min(SINGLE_REQUEST_INPUT_BUDGET, FULL_INPUT_SAFE_LIMIT) &&
    estimatedOutputTokens <= Math.min(SINGLE_REQUEST_OUTPUT_BUDGET, FULL_OUTPUT_SAFE_LIMIT) &&
    preparedSegments.length <= SINGLE_REQUEST_SEGMENT_BUDGET;

  if (shouldUseSingleRequest) {
    log("info", `Single-request mode (${preparedSegments.length} segments, ~${inputTokenCount} input tokens, provider: ${provider}, model: ${model})`);

    const translated = await translateChunk({
      sourceLanguage,
      targetLanguage,
      segments: preparedSegments,
      contextBefore: [],
      promptTerms,
      provider,
      model,
      apiKey
    });

    return {
      ok: true,
      mode: "single",
      translations: toOrderedTranslations(indexedSegments, translated),
      tokenInfo: { inputTokenCount, estimatedOutputTokens, chunkCount: 1, provider, model }
    };
  }

  const chunks = splitByCharacterBudget(preparedSegments, CHUNK_CHAR_LIMIT);
  const parallelism = Math.max(1, Math.min(PARALLEL_CHUNK_CONCURRENCY, chunks.length));

  log("info", `Chunked mode (${chunks.length} chunks, concurrency: ${parallelism}, provider: ${provider}, model: ${model})`);

  const translatedChunks = await mapChunksWithConcurrency(
    chunks,
    parallelism,
    async (chunk) => {
      const contextStart = Math.max(0, chunk[0].index - CHUNK_CONTEXT_WINDOW);
      const contextBefore = preparedSegments.slice(contextStart, chunk[0].index);
      return translateChunk({ sourceLanguage, targetLanguage, segments: chunk, contextBefore, promptTerms, provider, model, apiKey });
    }
  );

  return {
    ok: true,
    mode: "chunked",
    translations: toOrderedTranslations(indexedSegments, translatedChunks.flat()),
    tokenInfo: { inputTokenCount, estimatedOutputTokens, chunkCount: chunks.length, parallelism, provider, model }
  };
}

async function translateChunk({ sourceLanguage, targetLanguage, segments, contextBefore, promptTerms, provider, model, apiKey }) {
  const initialTranslations = await translateChunkOnce({
    sourceLanguage,
    targetLanguage,
    segments,
    contextBefore,
    promptTerms,
    provider,
    model,
    apiKey,
    extraRules: []
  });

  if (String(targetLanguage || "").toLowerCase() !== "tr") {
    return initialTranslations;
  }

  const initialMap = new Map(initialTranslations.map((item) => [item.index, item.text]));
  const retrySegments = segments.filter((segment) =>
    shouldRetryTurkishSegment(segment, initialMap.get(segment.index) || segment.originalText)
  );

  if (!retrySegments.length) {
    return initialTranslations;
  }

  log("info", `Retrying ${retrySegments.length} unchanged Turkish segment(s)`);

  const retriedTranslations = await translateChunkOnce({
    sourceLanguage,
    targetLanguage,
    segments: retrySegments,
    contextBefore: [],
    promptTerms,
    provider,
    model,
    apiKey,
    extraRules: TURKISH_RETRY_PROMPT_RULES
  });
  const retryMap = new Map(retriedTranslations.map((item) => [item.index, item.text]));

  return segments.map((segment) => {
    const initialText = initialMap.get(segment.index) || segment.originalText;
    const retryText = retryMap.get(segment.index);

    if (retryText && normalizeSegment(retryText) !== normalizeSegment(segment.originalText)) {
      return { index: segment.index, text: retryText };
    }

    return { index: segment.index, text: initialText };
  });
}

async function translateChunkOnce({ sourceLanguage, targetLanguage, segments, contextBefore, promptTerms, provider, model, apiKey, extraRules }) {
  const prompt = buildTranslationPrompt({
    sourceLanguage,
    targetLanguage,
    segments,
    contextBefore,
    protectedTerms: promptTerms,
    extraRules
  });

  const responseText = await translatePromptWithProvider({
    provider,
    model,
    apiKey,
    prompt,
    maxOutputTokens: estimateOutputTokens(segments.map((item) => item.originalText || item.text))
  });

  let parsed;

  try {
    parsed = parseTranslationJson(responseText, segments);
  } catch (error) {
    log("warn", `JSON parse fallback: ${error.message}`);
    return segments.map((seg) => ({ index: seg.index, text: seg.originalText }));
  }

  if (!parsed || !Array.isArray(parsed.translations)) {
    return segments.map((seg) => ({ index: seg.index, text: seg.originalText }));
  }

  const segmentMap = new Map(segments.map((seg) => [seg.index, seg]));
  const resultMap = new Map();

  for (const item of parsed.translations) {
    if (!item || typeof item.index !== "number") {
      continue;
    }

    const segment = segmentMap.get(item.index);

    if (!segment) {
      continue;
    }

    const text = typeof item.text === "string" ? item.text.trim() : "";

    if (text) {
      resultMap.set(item.index, finalizeSegmentTranslation(text, segment, targetLanguage));
    }
  }

  return segments.map((seg) => ({
    index: seg.index,
    text: resultMap.get(seg.index) || seg.originalText
  }));
}

// ── Segment Preparation ──

function toOrderedTranslations(originalSegments, translatedSegments) {
  const map = new Map();

  for (const item of translatedSegments) {
    map.set(item.index, item.text);
  }

  return originalSegments.map((seg) => map.get(seg.index) || seg.text);
}

function splitByCharacterBudget(indexedSegments, charLimit) {
  const chunks = [];
  let currentChunk = [];
  let currentChars = 0;

  for (const segment of indexedSegments) {
    const segmentLength = segment.text.length + 24;

    if (currentChunk.length && currentChars + segmentLength > charLimit) {
      chunks.push(currentChunk);
      currentChunk = [];
      currentChars = 0;
    }

    currentChunk.push(segment);
    currentChars += segmentLength;
  }

  if (currentChunk.length) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function prepareSegmentsForTranslation(indexedSegments, protectedTerms, targetLanguage) {
  return indexedSegments.map((segment) => {
    const masked = maskSegmentTerms(segment.text, protectedTerms, segment.index, targetLanguage);

    return {
      index: segment.index,
      text: masked.text,
      originalText: segment.text,
      placeholders: masked.placeholders
    };
  });
}

// ── Prompt Assembly ──

function buildTranslationPrompt({ sourceLanguage, targetLanguage, segments, contextBefore, protectedTerms, extraRules }) {
  const sourceLanguageName = resolveLanguageName(sourceLanguage);
  const targetLanguageName = resolveLanguageName(targetLanguage);
  const promptRules = getPromptRulesForLanguage(targetLanguage);
  const template = getPromptTemplate();
  const mergedRules = promptRules.concat(Array.isArray(extraRules) ? extraRules.filter(Boolean) : []);

  const payload = {
    source_language: sourceLanguageName,
    target_language: targetLanguageName,
    protected_terms: protectedTerms,
    context_before: contextBefore.map((item) => buildPromptSegment(item)),
    segments: segments.map((item) => buildPromptSegment(item))
  };

  return [
    template.role_line,
    applyPromptTemplate(template.translate_line_template, {
      source_language: sourceLanguageName,
      target_language: targetLanguageName
    }),
    template.rules_heading,
    ...mergedRules.map((rule, i) => `${i + 1}. ${rule}`),
    template.input_heading,
    JSON.stringify(payload)
  ].join("\n");
}

function buildPromptSegment(item) {
  return { index: item.index, text: item.text };
}

// ── Term Protection ──

function maskSegmentTerms(text, protectedTerms, segmentIndex, targetLanguage) {
  let maskedText = text;
  const placeholders = [];
  let counter = 0;
  const sortedTerms = Array.from(new Set(protectedTerms)).sort((a, b) => b.length - a.length);

  for (const term of sortedTerms) {
    if (!term || term.length < 2) {
      continue;
    }

    if (!shouldMaskTermForLanguage(term, targetLanguage)) {
      continue;
    }

    const pattern = buildProtectedTermPattern(term);

    maskedText = maskedText.replace(pattern, (match) => {
      const placeholder = `__TERM_${segmentIndex}_${counter}__`;
      counter += 1;
      placeholders.push({ placeholder, value: match });
      return placeholder;
    });
  }

  return { text: maskedText, placeholders };
}

function shouldMaskTermForLanguage(term, targetLanguage) {
  if (String(targetLanguage || "").toLowerCase() !== "tr") {
    return true;
  }

  return term.includes(" ") || /[0-9]/.test(term) || /[._/:+-]/.test(term);
}

function restorePlaceholders(text, placeholders) {
  let output = text;

  for (const item of placeholders || []) {
    output = output.split(item.placeholder).join(item.value);
  }

  return output;
}

function finalizeSegmentTranslation(text, segment, targetLanguage) {
  const normalizedText = String(text || "").trim();

  if (!normalizedText) {
    return segment.originalText;
  }

  if (hasPlaceholderIntegrityViolation(normalizedText, segment.placeholders)) {
    log("warn", `Placeholder integrity fallback on segment ${segment.index}`);
    return segment.originalText;
  }

  if (isSuspiciousHybridTranslation(normalizedText, segment, targetLanguage)) {
    log("warn", `Suspicious hybrid fallback on segment ${segment.index}`);
    return segment.originalText;
  }

  return restorePlaceholders(normalizedText, segment.placeholders);
}

function shouldRetryTurkishSegment(segment, translatedText) {
  if (!segment) {
    return false;
  }

  const source = normalizeSegment(segment.originalText);
  const target = normalizeSegment(translatedText);

  if (!source || !target) {
    return false;
  }

  if (source !== target) {
    return false;
  }

  if (!/[A-Za-z]/.test(source)) {
    return false;
  }

  if (/^[A-Za-z0-9_./:+-]+$/.test(source)) {
    return false;
  }

  return true;
}

function hasPlaceholderIntegrityViolation(text, placeholders) {
  const expected = Array.isArray(placeholders) ? placeholders : [];

  if (!expected.length) {
    return false;
  }

  for (const item of expected) {
    if (!text.includes(item.placeholder)) {
      return true;
    }
  }

  return false;
}

function isSuspiciousHybridTranslation(text, segment, targetLanguage) {
  if (String(targetLanguage || "").toLowerCase() !== "tr") {
    return false;
  }

  if (!segment) {
    return false;
  }

  const normalized = normalizeDashes(String(text || ""));
  const sourceNormalized = normalizeDashes(String(segment.originalText || ""));
  const sourceHyphenTokens = new Set(extractHyphenatedProtectedTokens(sourceNormalized).map((item) => item.toLowerCase()));
  const sourceWordSet = new Set((sourceNormalized.match(/\b[a-z0-9+#._]+\b/gi) || []).map((item) => item.toLowerCase()));
  const targetHyphenTokens = extractHyphenatedProtectedTokens(normalized);

  for (const token of targetHyphenTokens) {
    const lowerToken = token.toLowerCase();

    if (sourceHyphenTokens.has(lowerToken)) {
      continue;
    }

    const parts = lowerToken.split("-").filter(Boolean);

    if (parts.length >= 2 && parts.every((part) => sourceWordSet.has(part))) {
      continue;
    }

    if (parts.length >= 2 && parts.every((part) => candidateTermSet.has(part) || sourceWordSet.has(part))) {
      continue;
    }

    if (/^[a-z0-9+#._-]+$/i.test(token)) {
      return true;
    }
  }

  return false;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildProtectedTermPattern(term) {
  const normalized = String(term || "").trim();

  if (!normalized.includes(" ")) {
    return new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(normalized)}(?![A-Za-z0-9_])`, "gi");
  }

  const parts = splitTermWords(normalized);
  const joiner = "[\\s\\-\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D]+";
  const body = parts.map((part) => escapeRegex(part)).join(joiner);
  return new RegExp(`(?<![A-Za-z0-9_])${body}(?![A-Za-z0-9_])`, "gi");
}

function extractProtectedTerms(segments, targetLanguage) {
  const terms = new Set(alwaysProtectTerms);
  const tokenRegex = /\b[A-Za-z][A-Za-z0-9_./:+-]{1,40}\b/g;

  for (const segment of segments) {
    for (const token of extractHyphenatedProtectedTokens(segment)) {
      terms.add(token);
    }

    tokenRegex.lastIndex = 0;
    let match;

    while ((match = tokenRegex.exec(segment)) !== null) {
      if (shouldProtectToken(match[0], targetLanguage)) {
        terms.add(match[0]);
      }
    }

    for (const phrase of extractPhraseCandidates(segment, targetLanguage)) {
      terms.add(phrase);
    }
  }

  return Array.from(terms)
    .filter((term) => term && term.length > 1)
    .sort((a, b) => b.length - a.length)
    .slice(0, 400);
}

function extractHyphenatedProtectedTokens(segment) {
  const normalized = normalizeDashes(String(segment || ""));
  const matches = normalized.match(/\b[A-Za-z0-9+#._]+(?:-[A-Za-z0-9+#._]+)+\b/g);
  return matches || [];
}

function shouldProtectToken(token, targetLanguage) {
  const lower = token.toLowerCase();
  const isTurkishTarget = String(targetLanguage || "").toLowerCase() === "tr";

  if (candidateTermSet.has(lower)) {
    if (!isTurkishTarget) {
      return true;
    }

    if (shouldProtectTurkishWordToken(token)) {
      return true;
    }
  }

  if (!isTurkishTarget) {
    if (lower.endsWith("ies") && candidateTermSet.has(lower.slice(0, -3) + "y")) {
      return true;
    }

    if (lower.endsWith("es") && candidateTermSet.has(lower.slice(0, -2))) {
      return true;
    }

    if (lower.endsWith("s") && candidateTermSet.has(lower.slice(0, -1))) {
      return true;
    }
  }

  if (token.length > 2 && /[._/:+-]/.test(token)) {
    return true;
  }

  if (/[0-9]/.test(token)) {
    return true;
  }

  if (/^[A-Z0-9_]+$/.test(token) && token.length <= 16) {
    return true;
  }

  return false;
}

function shouldProtectTurkishWordToken(token) {
  const value = String(token || "");

  if (!value) {
    return false;
  }

  if (/[0-9]/.test(value) || /[._/:+-]/.test(value)) {
    return true;
  }

  if (/^[A-Z0-9_]+$/.test(value) && value.length <= 32) {
    return true;
  }

  if (/[a-z][A-Z]/.test(value) || /[A-Z][a-z]+[A-Z]/.test(value)) {
    return true;
  }

  return false;
}

function extractPhraseCandidates(segment, targetLanguage) {
  if (String(targetLanguage || "").toLowerCase() === "tr") {
    return [];
  }

  const words = tokenizePhraseText(segment);
  const phrases = new Set();

  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const phraseWords = words.slice(i, i + n);
      const phrase = phraseWords.join(" ");

      if (candidatePhraseSet.has(phrase) || isTechnicalPhraseCandidate(phraseWords)) {
        phrases.add(phrase);
      }
    }
  }

  return Array.from(phrases);
}

function isTechnicalPhraseCandidate(words) {
  const normalizedWords = words
    .map((word) => singularizeWord(String(word || "").trim().toLowerCase()))
    .filter(Boolean);

  if (normalizedWords.length < 2 || normalizedWords.length > 4) {
    return false;
  }

  if (normalizedWords.some((word) => TECHNICAL_PHRASE_STOP_WORDS.has(word))) {
    return false;
  }

  const knownCount = normalizedWords.filter((word) => candidateWordSet.has(word) || candidateTermSet.has(word)).length;

  if (knownCount !== normalizedWords.length) {
    return false;
  }

  const firstWord = normalizedWords[0];
  const lastWord = normalizedWords[normalizedWords.length - 1];
  const exactPhrase = normalizedWords.join(" ");
  const headMatches = candidateHeadWordSet.has(lastWord) || candidateTermSet.has(lastWord);
  const anchorMatches =
    candidateTermSet.has(firstWord) ||
    candidateTermSet.has(lastWord) ||
    candidateHeadWordSet.has(lastWord);

  if (candidatePhraseSet.has(exactPhrase)) {
    return true;
  }

  return headMatches && anchorMatches;
}

// ── Prompt Rules ──

function getPromptRulesForLanguage(targetLanguage) {
  const code = String(targetLanguage || "").toLowerCase();
  const config = promptRulesConfig || {};
  const commonRules = Array.isArray(config.common_rules) ? config.common_rules : [];
  const languageRules = config.language_rules && typeof config.language_rules === "object" ? config.language_rules : {};
  const defaultRules = languageRules.default || {};
  const specificRules = languageRules[code] || {};
  const merged = [...commonRules];

  const styleRule = specificRules.style_rule || defaultRules.style_rule;

  if (styleRule) {
    merged.push(styleRule);
  }

  const extraRules = [...(defaultRules.extra_rules || []), ...(specificRules.extra_rules || [])];

  for (const rule of extraRules) {
    const normalized = normalizePromptRuleLine(rule);

    if (normalized) {
      merged.push(normalized);
    }
  }

  return Array.from(new Set(merged));
}

function getPromptTemplate() {
  const template = promptRulesConfig && promptRulesConfig.prompt_template;

  if (!template) {
    throw new Error("Prompt template is not loaded.");
  }

  return template;
}

function applyPromptTemplate(template, variables) {
  return String(template || "").replace(/\{\{([a-z_]+)\}\}/gi, (fullMatch, key) => {
    const value = variables && Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : fullMatch;
    return String(value || "");
  });
}

// ── Bootstrap ──

async function bootstrap() {
  if (!bootstrapPromise) {
    bootstrapPromise = initializeTranslatorCore();
  }

  await bootstrapPromise;
  return getRuntimeInfo();
}

async function initializeTranslatorCore() {
  const [termsConfig, rulesConfig] = await Promise.all([
    loadTermsConfig(DEFAULT_TERMS_SOURCE),
    loadPromptRulesConfig(PROMPT_RULES_SOURCE)
  ]);

  alwaysProtectTerms = normalizeTermList(termsConfig.always_protect || []);
  candidateTerms = normalizeTermList(termsConfig.candidate_terms || []);
  candidateTermSet = new Set(candidateTerms);
  candidatePhraseSet = buildCandidatePhraseSet(candidateTerms);
  candidateWordSet = buildCandidateWordSet(candidateTerms);
  candidateHeadWordSet = buildCandidateHeadWordSet(candidateTerms);
  termsSourceInfo = termsConfig.source || DEFAULT_TERMS_SOURCE;
  promptRulesConfig = rulesConfig;
  promptRulesInfo = rulesConfig.source || PROMPT_RULES_SOURCE;
}

function getRuntimeInfo() {
  return {
    defaultProvider: DEFAULT_PROVIDER,
    defaultModels: { ...DEFAULT_PROVIDER_MODELS },
    promptRules: promptRulesInfo,
    termsSource: termsSourceInfo
  };
}

async function loadTermsConfig(source) {
  const raw = await loadTextFromSource(source);
  const parsed = JSON.parse(raw);

  if (parsed && Array.isArray(parsed.always_protect) && Array.isArray(parsed.candidate_terms)) {
    return {
      source,
      always_protect: parsed.always_protect,
      candidate_terms: parsed.candidate_terms
    };
  }

  if (parsed && Array.isArray(parsed.terms)) {
    const terms = parsed.terms
      .map((item) => (item && typeof item.en === "string" ? item.en : ""))
      .filter(Boolean);
    const version = parsed.metadata && parsed.metadata.version ? ` v${parsed.metadata.version}` : "";

    return {
      source: `${source}${version}`,
      always_protect: [],
      candidate_terms: terms
    };
  }

  throw new Error("Unsupported terms file format.");
}

async function loadPromptRulesConfig(source) {
  const raw = await loadTextFromSource(source);
  const parsed = JSON.parse(raw);

  const promptTemplate = normalizePromptTemplate(parsed && parsed.prompt_template);
  const commonRules = normalizePromptRuleList(parsed && parsed.common_rules);
  const languageRules = normalizePromptLanguageRules(parsed && parsed.language_rules);

  if (!promptTemplate) {
    throw new Error("Invalid prompt rules: prompt_template is missing or incomplete.");
  }

  if (!commonRules.length) {
    throw new Error("Invalid prompt rules: common_rules is empty.");
  }

  if (!languageRules.default || !languageRules.default.style_rule) {
    throw new Error("Invalid prompt rules: language_rules.default.style_rule is required.");
  }

  return { source, prompt_template: promptTemplate, common_rules: commonRules, language_rules: languageRules };
}

async function loadTextFromSource(source) {
  const response = await fetch(source);

  if (!response.ok) {
    throw new Error(`Failed to load bundled file (HTTP ${response.status}).`);
  }

  return response.text();
}

// ── Normalization Helpers ──

function normalizeTermList(list) {
  return Array.from(
    new Set(
      (list || [])
        .map((term) =>
          normalizeDashes(String(term || ""))
            .trim()
            .toLowerCase()
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/[\u2018\u2019]/g, "'")
            .replace(/^[\s"'`]+/, "")
            .replace(/[\s"'`]+$/, "")
            .replace(/\s+/g, " ")
        )
        .filter((term) => term.length > 1 && term.length <= 80)
    )
  );
}

function buildCandidatePhraseSet(terms) {
  const phrases = new Set();

  for (const term of terms || []) {
    if (!term || !term.includes(" ")) {
      continue;
    }

    phrases.add(term);
    phrases.add(singularizeLastWord(term));
  }

  return phrases;
}

function buildCandidateWordSet(terms) {
  const words = new Set();

  for (const term of terms || []) {
    for (const word of splitTermWords(term)) {
      if (word) {
        words.add(word);
        words.add(singularizeWord(word));
      }
    }
  }

  return words;
}

function buildCandidateHeadWordSet(terms) {
  const heads = new Set();

  for (const term of terms || []) {
    const words = splitTermWords(term);

    if (words.length < 2) {
      continue;
    }

    const head = singularizeWord(words[words.length - 1]);

    if (head) {
      heads.add(head);
    }
  }

  return heads;
}

function singularizeLastWord(phrase) {
  const words = String(phrase || "").split(" ");

  if (!words.length) {
    return "";
  }

  words[words.length - 1] = singularizeWord(words[words.length - 1]);
  return words.join(" ").trim();
}

function singularizeWord(word) {
  const value = String(word || "");

  if (value.length <= 3) {
    return value;
  }

  if (value.endsWith("ies")) {
    return value.slice(0, -3) + "y";
  }

  if (value.endsWith("es")) {
    return value.slice(0, -2);
  }

  if (value.endsWith("s")) {
    return value.slice(0, -1);
  }

  return value;
}

function splitTermWords(term) {
  return normalizeDashes(String(term || ""), " ")
    .toLowerCase()
    .match(/[a-z0-9+#._-]+/g) || [];
}

function tokenizePhraseText(text) {
  const tokens = normalizeDashes(String(text || ""), " ")
    .replace(/-/g, " ")
    .toLowerCase()
    .match(/[a-z0-9+#._-]+/g) || [];

  return tokens
    .map((token) => token.replace(/^[._-]+|[._-]+$/g, ""))
    .filter(Boolean);
}

function normalizePromptRuleList(list) {
  if (!Array.isArray(list)) {
    return [];
  }

  return list.map((rule) => normalizePromptRuleLine(rule)).filter(Boolean);
}

function normalizePromptTemplate(template) {
  if (!template || typeof template !== "object") {
    return null;
  }

  const roleLine = normalizePromptRuleLine(template.role_line);
  const translateLineTemplate = normalizePromptRuleLine(template.translate_line_template);
  const rulesHeading = normalizePromptRuleLine(template.rules_heading);
  const inputHeading = normalizePromptRuleLine(template.input_heading);

  if (!roleLine || !translateLineTemplate || !rulesHeading || !inputHeading) {
    return null;
  }

  return {
    role_line: roleLine,
    translate_line_template: translateLineTemplate,
    rules_heading: rulesHeading,
    input_heading: inputHeading
  };
}

function normalizePromptRuleLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizePromptLanguageRules(languageRules) {
  const rules = {};

  if (!languageRules || typeof languageRules !== "object") {
    return rules;
  }

  for (const [key, value] of Object.entries(languageRules)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const code = String(key || "").toLowerCase().trim();

    if (!code) {
      continue;
    }

    const styleRule = normalizePromptRuleLine(value.style_rule);
    const extraRules = normalizePromptRuleList(value.extra_rules);

    if (!styleRule && !extraRules.length) {
      continue;
    }

    rules[code] = { style_rule: styleRule, extra_rules: extraRules };
  }

  return rules;
}

function resolveLanguageName(code) {
  return LANGUAGE_MAP[String(code || "").toLowerCase()] || code || "Target language";
}

function normalizeLanguage(value, fallback) {
  const text = String(value || "").trim().toLowerCase();
  return text || fallback;
}

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  return DEFAULT_PROVIDER_MODELS[provider] ? provider : DEFAULT_PROVIDER;
}

function resolveProviderModel(provider, requestedModel) {
  const model = String(requestedModel || "").trim();
  return model || DEFAULT_PROVIDER_MODELS[provider] || DEFAULT_PROVIDER_MODELS[DEFAULT_PROVIDER];
}

function resolveProviderApiKey(provider, requestedApiKey) {
  const apiKey = String(requestedApiKey || "").trim();
  return apiKey;
}

function normalizeSegment(value) {
  if (typeof value !== "string") {
    return "";
  }

  return normalizeDashes(value).replace(/\s+/g, " ").trim();
}

function normalizeDashes(value, replacement = "-") {
  return String(value || "").replace(UNICODE_DASH_REGEX, replacement);
}

// ── Token Estimation ──

function estimateOutputTokens(segments) {
  const joined = segments.join(" ");
  return Math.max(Math.ceil(joined.length / 4.2), 256);
}

function estimateInputTokens(prompt) {
  return Math.max(64, Math.ceil(String(prompt || "").length / 3.8));
}

// ── Concurrency ──

async function mapChunksWithConcurrency(chunks, concurrency, worker) {
  if (!chunks.length) {
    return [];
  }

  const results = new Array(chunks.length);
  let cursor = 0;

  async function runWorker() {
    while (cursor < chunks.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(chunks[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, chunks.length));
  const runners = [];

  for (let i = 0; i < workerCount; i++) {
    runners.push(runWorker());
  }

  await Promise.all(runners);
  return results;
}

// ── Provider APIs ──

async function translatePromptWithProvider({ provider, model, apiKey, prompt, maxOutputTokens }) {
  if (!apiKey) {
    throw new Error(`No API key configured for provider "${provider}". Save one in the popup before translating.`);
  }

  if (provider === "openai") {
    const json = await callOpenAiApi(model, apiKey, buildOpenAiBody(prompt, maxOutputTokens));
    return extractOpenAiResponseText(json);
  }

  if (provider === "anthropic") {
    const json = await callAnthropicApi(model, apiKey, buildAnthropicBody(prompt, maxOutputTokens));
    return extractAnthropicResponseText(json);
  }

  if (provider === "deepseek") {
    const json = await callDeepSeekApi(model, apiKey, buildDeepSeekBody(prompt, maxOutputTokens));
    return extractDeepSeekResponseText(json);
  }

  const json = await callGeminiApi(model, apiKey, "generateContent", buildGeminiBody(prompt));
  return extractGeminiResponseText(json);
}

function buildGeminiBody(prompt) {
  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: buildGeminiResponseSchema()
    }
  };
}

function buildOpenAiBody(prompt, maxOutputTokens) {
  return {
    input: prompt,
    temperature: 0,
    max_output_tokens: clampOutputTokens(maxOutputTokens),
    text: {
      format: {
        type: "json_schema",
        name: "subtitle_translations",
        strict: true,
        schema: buildJsonSchemaResponse()
      }
    }
  };
}

function buildAnthropicBody(prompt, maxOutputTokens) {
  return {
    system: "Return valid JSON only. Follow the user's requested schema exactly.",
    max_tokens: clampOutputTokens(maxOutputTokens),
    temperature: 0,
    messages: [{ role: "user", content: prompt }]
  };
}

function buildDeepSeekBody(prompt, maxOutputTokens) {
  return {
    messages: [
      {
        role: "system",
        content: "Return valid JSON only. Follow the user's requested schema exactly."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    temperature: 0,
    max_tokens: clampOutputTokens(maxOutputTokens),
    response_format: {
      type: "json_object"
    },
    stream: false
  };
}

function buildGeminiResponseSchema() {
  return {
    type: "OBJECT",
    required: ["translations"],
    properties: {
      translations: {
        type: "ARRAY",
        items: {
          type: "OBJECT",
          required: ["index", "text"],
          properties: {
            index: { type: "INTEGER" },
            text: { type: "STRING" }
          }
        }
      }
    }
  };
}

function buildJsonSchemaResponse() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["translations"],
    properties: {
      translations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["index", "text"],
          properties: {
            index: { type: "integer" },
            text: { type: "string" }
          }
        }
      }
    }
  };
}

function clampOutputTokens(value) {
  return Math.max(256, Math.min(Math.ceil(Number(value) || 256), 4096));
}

async function callGeminiApi(model, apiKey, action, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:${action}?key=${encodeURIComponent(apiKey)}`;
  return callJsonApi(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, "Gemini");
}

async function callOpenAiApi(model, apiKey, body) {
  const payload = { ...body, model };
  return callJsonApi(
    "https://api.openai.com/v1/responses",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    },
    "OpenAI"
  );
}

async function callAnthropicApi(model, apiKey, body) {
  const payload = { ...body, model };
  return callJsonApi(
    "https://api.anthropic.com/v1/messages",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      body: JSON.stringify(payload)
    },
    "Anthropic"
  );
}

async function callDeepSeekApi(model, apiKey, body) {
  const payload = { ...body, model };
  return callJsonApi(
    "https://api.deepseek.com/chat/completions",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(payload)
    },
    "DeepSeek"
  );
}

async function callJsonApi(url, options, providerLabel) {
  return retry(async () => {
    const response = await fetch(url, options);

    if (!response.ok) {
      const text = await response.text();
      const status = response.status;
      const retryable = status === 429 || status >= 500;
      const error = new Error(`${providerLabel} API error (${status}): ${trimForLog(text)}`);
      error.retryable = retryable;
      throw error;
    }

    return response.json();
  }, 3);
}

function extractGeminiResponseText(responseJson) {
  const candidates = responseJson && responseJson.candidates;

  if (!Array.isArray(candidates) || !candidates.length) {
    throw new Error("Gemini did not return any candidate response.");
  }

  const parts = candidates[0].content && candidates[0].content.parts;

  if (!Array.isArray(parts) || !parts.length) {
    throw new Error("Gemini response content parts are empty.");
  }

  return parts.map((part) => part.text || "").join("\n").trim();
}

function extractOpenAiResponseText(responseJson) {
  if (typeof responseJson.output_text === "string" && responseJson.output_text.trim()) {
    return responseJson.output_text.trim();
  }

  const outputs = Array.isArray(responseJson && responseJson.output) ? responseJson.output : [];
  const chunks = [];

  for (const item of outputs) {
    const content = Array.isArray(item && item.content) ? item.content : [];

    for (const entry of content) {
      if (typeof entry.text === "string" && entry.text.trim()) {
        chunks.push(entry.text.trim());
      }
    }
  }

  if (!chunks.length) {
    throw new Error("OpenAI response text is empty.");
  }

  return chunks.join("\n").trim();
}

function extractAnthropicResponseText(responseJson) {
  const content = Array.isArray(responseJson && responseJson.content) ? responseJson.content : [];
  const chunks = content
    .map((item) => (item && item.type === "text" && typeof item.text === "string" ? item.text.trim() : ""))
    .filter(Boolean);

  if (!chunks.length) {
    throw new Error("Anthropic response text is empty.");
  }

  return chunks.join("\n").trim();
}

function extractDeepSeekResponseText(responseJson) {
  const choices = Array.isArray(responseJson && responseJson.choices) ? responseJson.choices : [];

  if (!choices.length) {
    throw new Error("DeepSeek response choices are empty.");
  }

  const message = choices[0] && choices[0].message;
  const content = typeof (message && message.content) === "string" ? message.content.trim() : "";

  if (!content) {
    throw new Error("DeepSeek response text is empty.");
  }

  return content;
}

// ── Response Parsing ──

function parseTranslationJson(text, segments) {
  const input = String(text || "").trim();

  const fromJson = tryParseJsonCandidates(input, segments);

  if (fromJson) {
    return fromJson;
  }

  const fromPairs = parseIndexTextPairs(input, segments);

  if (fromPairs) {
    return fromPairs;
  }

  return { translations: [] };
}

function tryParseJsonCandidates(text, segments) {
  if (!text) {
    return null;
  }

  const candidates = [text];
  const fencedRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fencedMatch;

  while ((fencedMatch = fencedRegex.exec(text)) !== null) {
    if (fencedMatch[1] && fencedMatch[1].trim()) {
      candidates.push(fencedMatch[1].trim());
    }
  }

  candidates.push(...extractJsonCandidates(text));

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      const normalized = normalizeGeminiPayload(parsed, segments);

      if (normalized) {
        return normalized;
      }
    } catch (_) {
      // Try next candidate.
    }
  }

  return null;
}

function normalizeGeminiPayload(parsed, segments) {
  const orderedIndexes = Array.isArray(segments) ? segments.map((item) => item.index) : [];

  const list = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object" && Array.isArray(parsed.translations)
      ? parsed.translations
      : null;

  if (!Array.isArray(list)) {
    return null;
  }

  if (!list.length) {
    return { translations: [] };
  }

  const translationMap = new Map();

  for (let i = 0; i < list.length; i++) {
    const item = list[i];
    let index = null;
    let text = "";

    if (typeof item === "string") {
      if (i < orderedIndexes.length) {
        index = orderedIndexes[i];
        text = item.trim();
      }
    } else if (item && typeof item === "object") {
      index = parseLooseInteger(item.index);

      if (index === null && i < orderedIndexes.length) {
        index = orderedIndexes[i];
      }

      text = extractTextValue(item).trim();
    }

    if (index !== null && text) {
      translationMap.set(index, text);
    }
  }

  if (!translationMap.size) {
    return null;
  }

  return {
    translations: Array.from(translationMap, ([index, value]) => ({ index, text: value }))
  };
}

function extractTextValue(item) {
  if (!item || typeof item !== "object") {
    return "";
  }

  const fields = ["text", "translation", "translatedText", "translated_text", "output", "value"];

  for (const field of fields) {
    if (typeof item[field] === "string") {
      return item[field];
    }
  }

  return "";
}

function parseLooseInteger(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number(value.trim());
  }

  return null;
}

function parseIndexTextPairs(text, segments) {
  if (!text) {
    return null;
  }

  const orderedIndexes = Array.isArray(segments) ? segments.map((item) => item.index) : [];

  const pairRegexes = [
    /"index"\s*:\s*(-?\d+)[\s\S]{0,300}?"text"\s*:\s*"((?:\\.|[^"\\])*)"/g,
    /"text"\s*:\s*"((?:\\.|[^"\\])*)"[\s\S]{0,300}?"index"\s*:\s*(-?\d+)/g,
    /\bindex\b\s*[:=]\s*(-?\d+)[\s,]*\btext\b\s*[:=]\s*"((?:\\.|[^"\\])*)"/gi
  ];

  const map = new Map();

  for (const regex of pairRegexes) {
    regex.lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      const first = match[1] || "";
      const second = match[2] || "";
      const hasIndexFirst = /^-?\d+$/.test(String(first).trim());
      const index = hasIndexFirst ? Number(first) : Number(second);
      const rawText = hasIndexFirst ? second : first;
      const cleaned = decodeEscapedJsonString(rawText).trim();

      if (Number.isInteger(index) && cleaned) {
        map.set(index, cleaned);
      }
    }
  }

  if (!map.size && orderedIndexes.length) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);

    if (lines.length >= orderedIndexes.length) {
      for (let i = 0; i < orderedIndexes.length; i++) {
        const line = lines[i].replace(/^\s*[-*]\s*/, "");

        if (line) {
          map.set(orderedIndexes[i], line);
        }
      }
    }
  }

  if (!map.size) {
    return null;
  }

  return {
    translations: Array.from(map, ([index, value]) => ({ index, text: value }))
  };
}

function decodeEscapedJsonString(value) {
  const text = String(value || "");

  try {
    return JSON.parse(`"${text}"`);
  } catch (_) {
    return text
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
}

function extractJsonCandidates(text) {
  const candidates = [];
  const input = String(text || "");
  const stack = [];
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{" || ch === "[") {
      if (!stack.length) {
        start = i;
      }
      stack.push(ch);
      continue;
    }

    if (ch === "}" || ch === "]") {
      if (!stack.length) {
        continue;
      }

      const expected = ch === "}" ? "{" : "[";

      if (stack[stack.length - 1] !== expected) {
        stack.length = 0;
        start = -1;
        continue;
      }

      stack.pop();

      if (!stack.length && start !== -1) {
        candidates.push(input.slice(start, i + 1));
        start = -1;
      }
    }
  }

  return candidates;
}

// ── Utilities ──

async function retry(fn, attempts) {
  let lastError;

  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!error.retryable || i === attempts - 1) {
        break;
      }

      await sleep(500 * (i + 1));
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(level, message) {
  if (level === "info") {
    return;
  }

  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [${level.toUpperCase()}]`;
  const output = `${prefix} ${message}`;

  if (level === "error") {
    console.error(output);
  } else if (level === "warn") {
    console.warn(output);
  } else {
    console.log(output);
  }
}

function trimForLog(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length > 220 ? normalized.slice(0, 220) + "..." : normalized;
}

const TranslatorCore = {
  initialize: bootstrap,
  translateRequest,
  getRuntimeInfo
};

if (typeof globalThis !== "undefined") {
  globalThis.TranslatorCore = TranslatorCore;
}
})();
