const fs = require("fs");
const http = require("http");
const path = require("path");

const PORT = Number(process.env.GEMINI_PROXY_PORT || 8787);
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";

const FULL_INPUT_TOKEN_LIMIT = 1048576;
const FULL_OUTPUT_TOKEN_LIMIT = 65536;
const FULL_INPUT_SAFE_LIMIT = Math.floor(FULL_INPUT_TOKEN_LIMIT * 0.9);
const FULL_OUTPUT_SAFE_LIMIT = Math.floor(FULL_OUTPUT_TOKEN_LIMIT * 0.85);

const CHUNK_CHAR_LIMIT = Number(process.env.CHUNK_CHAR_LIMIT || 8000);
const CHUNK_CONTEXT_WINDOW = Number(process.env.CHUNK_CONTEXT_WINDOW || 4);
const PARALLEL_CHUNK_CONCURRENCY = Number(process.env.PARALLEL_CHUNK_CONCURRENCY || 2);
const SINGLE_REQUEST_INPUT_BUDGET = Number(process.env.SINGLE_REQUEST_INPUT_BUDGET || 1800);
const SINGLE_REQUEST_OUTPUT_BUDGET = Number(process.env.SINGLE_REQUEST_OUTPUT_BUDGET || 1200);
const SINGLE_REQUEST_SEGMENT_BUDGET = Number(process.env.SINGLE_REQUEST_SEGMENT_BUDGET || 25);
const DEFAULT_TERMS_SOURCE = path.join(__dirname, "tech_terms_dictionary.json");
const DEFAULT_PROMPT_RULES_SOURCE = path.join(__dirname, "prompt-rules.json");

const LANGUAGE_MAP = {
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
const PROMPT_RULES_SOURCE = process.env.PROMPT_RULES_SOURCE || DEFAULT_PROMPT_RULES_SOURCE;

let TERMS_SOURCE_INFO = DEFAULT_TERMS_SOURCE;
let PROMPT_RULES_INFO = PROMPT_RULES_SOURCE;
let ALWAYS_PROTECT_TERMS = [];
let CANDIDATE_TERMS = [];
let CANDIDATE_TERM_SET = new Set();
let CANDIDATE_PHRASE_SET = new Set();
let PROMPT_RULES_CONFIG = null;

if (!GEMINI_API_KEY) {
  console.error("GEMINI_API_KEY is missing. Define it in your environment first.");
  process.exit(1);
}

const server = http.createServer(async (req, res) => {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, { ok: true, model: GEMINI_MODEL });
    return;
  }

  if (req.method === "POST" && req.url === "/translate") {
    try {
      const body = await readJsonBody(req);
      const response = await translateRequest(body);
      sendJson(res, 200, response);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: "Route not found." });
});

bootstrap().catch((error) => {
  console.error(`Proxy failed to start: ${error.message}`);
  process.exit(1);
});

async function translateRequest(payload) {
  const segments = Array.isArray(payload && payload.segments) ? payload.segments : [];
  if (!segments.length) {
    throw new Error("segments array cannot be empty.");
  }

  const cleanedSegments = segments.map((item) => normalizeSegment(item));
  const indexedSegments = cleanedSegments.map((text, index) => ({ index, text }));

  const sourceLanguage = normalizeLanguage(payload && payload.sourceLanguage, "en");
  const targetLanguage = normalizeLanguage(payload && payload.targetLanguage, "tr");
  const protectedTerms = extractProtectedTerms(cleanedSegments);
  const promptTerms = protectedTerms.slice(0, 90);
  const preparedSegments = prepareSegmentsForTranslation(indexedSegments, protectedTerms);

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
    const translated = await translateChunk({
      sourceLanguage,
      targetLanguage,
      segments: preparedSegments,
      contextBefore: [],
      promptTerms
    });

    return {
      ok: true,
      mode: "single",
      translations: toOrderedTranslations(indexedSegments, translated),
      tokenInfo: {
        inputTokenCount,
        estimatedOutputTokens,
        chunkCount: 1
      }
    };
  }

  const chunks = splitByCharacterBudget(preparedSegments, CHUNK_CHAR_LIMIT);
  const translatedChunks = await mapChunksWithConcurrency(
    chunks,
    Math.max(1, PARALLEL_CHUNK_CONCURRENCY),
    async (chunk) => {
      const contextStart = Math.max(0, chunk[0].index - CHUNK_CONTEXT_WINDOW);
      const contextBefore = preparedSegments.slice(contextStart, chunk[0].index);
      return translateChunk({
        sourceLanguage,
        targetLanguage,
        segments: chunk,
        contextBefore,
        promptTerms
      });
    }
  );

  const mergedTranslations = translatedChunks.flat();

  return {
    ok: true,
    mode: "chunked",
    translations: toOrderedTranslations(indexedSegments, mergedTranslations),
    tokenInfo: {
      inputTokenCount,
      estimatedOutputTokens,
      chunkCount: chunks.length,
      parallelism: Math.max(1, Math.min(PARALLEL_CHUNK_CONCURRENCY, chunks.length))
    }
  };
}

async function translateChunk({ sourceLanguage, targetLanguage, segments, contextBefore, promptTerms }) {
  const prompt = buildTranslationPrompt({
    sourceLanguage,
    targetLanguage,
    segments,
    contextBefore,
    protectedTerms: promptTerms
  });

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: "application/json",
      responseSchema: {
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
      }
    }
  };

  const json = await callGeminiApi("generateContent", body);
  const responseText = extractResponseText(json);
  let parsed;
  try {
    parsed = parseGeminiJson(responseText, segments);
  } catch (error) {
    console.warn(`JSON parse fallback enabled: ${error.message}`);
    return segments.map((segment) => ({
      index: segment.index,
      text: segment.originalText
    }));
  }

  if (!parsed || !Array.isArray(parsed.translations)) {
    return segments.map((segment) => ({
      index: segment.index,
      text: segment.originalText
    }));
  }

  const segmentMap = new Map(segments.map((segment) => [segment.index, segment]));
  const map = new Map();
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
      map.set(item.index, restorePlaceholders(text, segment.placeholders));
    }
  }

  return segments.map((segment) => ({
    index: segment.index,
    text: map.get(segment.index) || segment.originalText
  }));
}

function toOrderedTranslations(originalSegments, translatedSegments) {
  const map = new Map();

  for (const item of translatedSegments) {
    map.set(item.index, item.text);
  }

  return originalSegments.map((segment) => map.get(segment.index) || segment.text);
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

function buildTranslationPrompt({ sourceLanguage, targetLanguage, segments, contextBefore, protectedTerms }) {
  const sourceLanguageName = resolveLanguageName(sourceLanguage);
  const targetLanguageName = resolveLanguageName(targetLanguage);
  const promptRules = getPromptRulesForLanguage(targetLanguage);
  const promptTemplate = getPromptTemplate();

  const payload = {
    source_language: sourceLanguageName,
    target_language: targetLanguageName,
    protected_terms: protectedTerms,
    context_before: contextBefore.map((item) => ({
      index: item.index,
      text: item.text
    })),
    segments: segments.map((item) => ({
      index: item.index,
      text: item.text
    }))
  };

  return [
    promptTemplate.role_line,
    applyPromptTemplate(promptTemplate.translate_line_template, {
      source_language: sourceLanguageName,
      target_language: targetLanguageName
    }),
    promptTemplate.rules_heading,
    ...promptRules.map((rule, index) => `${index + 1}. ${rule}`),
    promptTemplate.input_heading,
    JSON.stringify(payload)
  ].join("\n");
}

function prepareSegmentsForTranslation(indexedSegments, protectedTerms) {
  return indexedSegments.map((segment) => {
    const masked = maskSegmentTerms(segment.text, protectedTerms, segment.index);
    return {
      index: segment.index,
      text: masked.text,
      originalText: segment.text,
      placeholders: masked.placeholders
    };
  });
}

function maskSegmentTerms(text, protectedTerms, segmentIndex) {
  let maskedText = text;
  const placeholders = [];
  let counter = 0;
  const sortedTerms = Array.from(new Set(protectedTerms)).sort((a, b) => b.length - a.length);

  for (const term of sortedTerms) {
    if (!term || term.length < 2) {
      continue;
    }

    const pattern = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(term)}(?![A-Za-z0-9_])`, "gi");
    maskedText = maskedText.replace(pattern, (match) => {
      const placeholder = `__TERM_${segmentIndex}_${counter}__`;
      counter += 1;
      placeholders.push({ placeholder, value: match });
      return placeholder;
    });
  }

  return { text: maskedText, placeholders };
}

function restorePlaceholders(text, placeholders) {
  let output = text;
  for (const item of placeholders || []) {
    output = output.split(item.placeholder).join(item.value);
  }
  return output;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractProtectedTerms(segments) {
  const terms = new Set(ALWAYS_PROTECT_TERMS);
  const tokenRegex = /\b[A-Za-z][A-Za-z0-9_./:+-]{1,40}\b/g;

  for (const segment of segments) {
    tokenRegex.lastIndex = 0;
    let match;
    while ((match = tokenRegex.exec(segment)) !== null) {
      const token = match[0];
      if (shouldProtectToken(token)) {
        terms.add(token);
      }
    }

    for (const phrase of extractPhraseCandidates(segment)) {
      terms.add(phrase);
    }
  }

  return Array.from(terms)
    .filter((term) => term && term.length > 1)
    .sort((a, b) => b.length - a.length)
    .slice(0, 400);
}

function shouldProtectToken(token) {
  const lower = token.toLowerCase();

  if (CANDIDATE_TERM_SET.has(lower)) {
    return true;
  }

  if (lower.endsWith("ies") && CANDIDATE_TERM_SET.has(lower.slice(0, -3) + "y")) {
    return true;
  }

  if (lower.endsWith("es") && CANDIDATE_TERM_SET.has(lower.slice(0, -2))) {
    return true;
  }

  if (lower.endsWith("s") && CANDIDATE_TERM_SET.has(lower.slice(0, -1))) {
    return true;
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

function extractPhraseCandidates(segment) {
  const words = String(segment || "").toLowerCase().match(/[a-z0-9+#._-]+/g) || [];
  const phrases = new Set();

  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const phrase = words.slice(i, i + n).join(" ");
      if (CANDIDATE_PHRASE_SET.has(phrase)) {
        phrases.add(phrase);
      }
    }
  }

  return Array.from(phrases);
}

async function bootstrap() {
  const [termsConfig, promptRulesConfig] = await Promise.all([
    loadTermsConfig(DEFAULT_TERMS_SOURCE),
    loadPromptRulesConfig(PROMPT_RULES_SOURCE)
  ]);
  ALWAYS_PROTECT_TERMS = normalizeTermList(termsConfig.always_protect || []);
  CANDIDATE_TERMS = normalizeTermList(termsConfig.candidate_terms || []);
  CANDIDATE_TERM_SET = new Set(CANDIDATE_TERMS);
  CANDIDATE_PHRASE_SET = new Set(CANDIDATE_TERMS.filter((term) => term.includes(" ")));
  TERMS_SOURCE_INFO = termsConfig.source || DEFAULT_TERMS_SOURCE;
  PROMPT_RULES_CONFIG = promptRulesConfig;
  PROMPT_RULES_INFO = promptRulesConfig.source || PROMPT_RULES_SOURCE;

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`Gemini proxy ready: http://127.0.0.1:${PORT}`);
    console.log(`Model: ${GEMINI_MODEL}`);
    console.log(`Prompt rules source: ${PROMPT_RULES_INFO}`);
    console.log(`Terms source: ${TERMS_SOURCE_INFO} (candidates: ${CANDIDATE_TERMS.length})`);
  });
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
    const candidateTerms = parsed.terms
      .map((item) => (item && typeof item.en === "string" ? item.en : ""))
      .filter(Boolean);
    const metadata = parsed.metadata || {};
    const version = metadata.version ? ` v${metadata.version}` : "";
    return {
      source: `${source}${version}`,
      always_protect: [],
      candidate_terms: candidateTerms
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
    throw new Error("Invalid prompt rules file: prompt_template is missing or incomplete.");
  }

  if (!commonRules.length) {
    throw new Error("Invalid prompt rules file: common_rules is empty.");
  }

  if (!languageRules.default || !languageRules.default.style_rule) {
    throw new Error("Invalid prompt rules file: language_rules.default.style_rule is required.");
  }

  return {
    source,
    prompt_template: promptTemplate,
    common_rules: commonRules,
    language_rules: languageRules
  };
}

async function loadTextFromSource(source) {
  if (/^https?:\/\//i.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new Error(`Failed to download remote terms file (HTTP ${response.status}).`);
    }
    return response.text();
  }

  const resolved = path.resolve(source);
  return fs.readFileSync(resolved, "utf8");
}

function normalizeTermList(list) {
  return Array.from(
    new Set(
      (list || [])
        .map((term) =>
          String(term || "")
            .trim()
            .toLowerCase()
            .replace(/[“”]/g, '"')
            .replace(/[‘’]/g, "'")
            .replace(/^[\s"'`]+/, "")
            .replace(/[\s"'`]+$/, "")
            .replace(/\s+/g, " ")
        )
        .filter((term) => term.length > 1 && term.length <= 80)
    )
  );
}

function normalizePromptRuleList(list) {
  if (!Array.isArray(list)) {
    return [];
  }

  return list
    .map((rule) => normalizePromptRuleLine(rule))
    .filter(Boolean);
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
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizePromptLanguageRules(languageRules) {
  const rules = {};
  if (!languageRules || typeof languageRules !== "object") {
    return rules;
  }

  for (const [languageCode, value] of Object.entries(languageRules)) {
    if (!value || typeof value !== "object") {
      continue;
    }

    const code = String(languageCode || "").toLowerCase().trim();
    if (!code) {
      continue;
    }

    const styleRule = normalizePromptRuleLine(value.style_rule);
    const extraRules = normalizePromptRuleList(value.extra_rules);
    if (!styleRule && !extraRules.length) {
      continue;
    }

    rules[code] = {
      style_rule: styleRule,
      extra_rules: extraRules
    };
  }

  return rules;
}

function getPromptRulesForLanguage(targetLanguage) {
  const languageCode = String(targetLanguage || "").toLowerCase();
  const config = PROMPT_RULES_CONFIG || {};
  const commonRules = Array.isArray(config.common_rules) ? config.common_rules : [];
  const languageRules = config.language_rules && typeof config.language_rules === "object" ? config.language_rules : {};
  const defaultRules = languageRules.default || {};
  const specificRules = languageRules[languageCode] || {};
  const mergedRules = [...commonRules];
  const styleRule = specificRules.style_rule || defaultRules.style_rule;
  if (styleRule) {
    mergedRules.push(styleRule);
  }

  const extraRules = [...(defaultRules.extra_rules || []), ...(specificRules.extra_rules || [])];
  for (const rule of extraRules) {
    const normalized = normalizePromptRuleLine(rule);
    if (normalized) {
      mergedRules.push(normalized);
    }
  }

  return Array.from(new Set(mergedRules));
}

function getPromptTemplate() {
  const template = PROMPT_RULES_CONFIG && PROMPT_RULES_CONFIG.prompt_template;
  if (!template) {
    throw new Error("Prompt template is not loaded.");
  }
  return template;
}

function applyPromptTemplate(template, variables) {
  const source = String(template || "");
  return source.replace(/\{\{([a-z_]+)\}\}/gi, (fullMatch, key) => {
    const value = variables && Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : fullMatch;
    return String(value || "");
  });
}

function resolveLanguageName(code) {
  return LANGUAGE_MAP[String(code || "").toLowerCase()] || code || "Target language";
}

function normalizeLanguage(value, fallback) {
  const text = String(value || "").trim().toLowerCase();
  return text || fallback;
}

function normalizeSegment(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim();
}

function estimateOutputTokens(segments) {
  const joined = segments.join(" ");
  const estimated = Math.ceil(joined.length / 4.2);
  return Math.max(estimated, 256);
}

function estimateInputTokens(prompt) {
  const chars = String(prompt || "").length;
  return Math.max(64, Math.ceil(chars / 3.8));
}

async function mapChunksWithConcurrency(chunks, concurrency, worker) {
  if (!chunks.length) {
    return [];
  }

  const results = new Array(chunks.length);
  let cursor = 0;

  async function runWorker() {
    while (true) {
      const currentIndex = cursor;
      cursor += 1;
      if (currentIndex >= chunks.length) {
        return;
      }

      results[currentIndex] = await worker(chunks[currentIndex], currentIndex);
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

async function callGeminiApi(action, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:${action}?key=${encodeURIComponent(GEMINI_API_KEY)}`;

  return retry(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const text = await response.text();
      const status = response.status;
      const retryable = status === 429 || status >= 500;
      const message = `Gemini API error (${status}): ${trimForLog(text)}`;
      const error = new Error(message);
      error.retryable = retryable;
      throw error;
    }

    return response.json();
  }, 3);
}

function extractResponseText(responseJson) {
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

function parseGeminiJson(text, segments) {
  const input = String(text || "").trim();
  const normalizedFromJson = tryParseJsonCandidates(input, segments);
  if (normalizedFromJson) {
    return normalizedFromJson;
  }

  const normalizedFromPairs = parseIndexTextPairs(input, segments);
  if (normalizedFromPairs) {
    return normalizedFromPairs;
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
    } catch (error) {
      // Try next candidate.
    }
  }

  return null;
}

function normalizeGeminiPayload(parsed, segments) {
  const orderedSegmentIndexes = Array.isArray(segments) ? segments.map((item) => item.index) : [];
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
      if (i < orderedSegmentIndexes.length) {
        index = orderedSegmentIndexes[i];
        text = item.trim();
      }
    } else if (item && typeof item === "object") {
      index = parseLooseInteger(item.index);
      if (index === null && i < orderedSegmentIndexes.length) {
        index = orderedSegmentIndexes[i];
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

  const orderedSegmentIndexes = Array.isArray(segments) ? segments.map((item) => item.index) : [];
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
      const cleanedText = decodeEscapedJsonString(rawText).trim();

      if (Number.isInteger(index) && cleanedText) {
        map.set(index, cleanedText);
      }
    }
  }

  if (!map.size && orderedSegmentIndexes.length) {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);

    if (lines.length >= orderedSegmentIndexes.length) {
      for (let i = 0; i < orderedSegmentIndexes.length; i++) {
        const line = lines[i].replace(/^\s*[-*]\s*/, "");
        if (line) {
          map.set(orderedSegmentIndexes[i], line);
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
  } catch (error) {
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
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }

    if (ch === "\"") {
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

      const backoff = 500 * (i + 1);
      await sleep(backoff);
    }
  }

  throw lastError;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trimForLog(text) {
  const normalized = String(text || "").replace(/\s+/g, " ").trim();
  return normalized.length > 220 ? normalized.slice(0, 220) + "..." : normalized;
}

function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";

    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5 * 1024 * 1024) {
        reject(new Error("Request body is too large."));
      }
    });

    req.on("end", () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Failed to parse JSON body."));
      }
    });

    req.on("error", () => {
      reject(new Error("Failed while reading request body."));
    });
  });
}
