importScripts("translation-runtime.js");

const BG_DEFAULT_TARGET_LANGUAGE = "tr";
const BG_DEFAULT_PROVIDER = "gemini";
const BG_TRANSLATION_UI_STATE_KEY = "translationUiState";
const BG_PROVIDER_DEFAULT_MODELS = {
  gemini: "gemini-3.1-flash-lite-preview",
  openai: "gpt-5.4-mini",
  anthropic: "claude-sonnet-4-20250514",
  deepseek: "deepseek-chat"
};
let translatorCoreInitPromise = null;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(
    {
      targetLanguage: BG_DEFAULT_TARGET_LANGUAGE,
      provider: BG_DEFAULT_PROVIDER,
      providerModels: {},
      providerApiKeys: {},
      translationUiState: {}
    },
    (items) => {
      chrome.storage.local.set({
        targetLanguage: items.targetLanguage || BG_DEFAULT_TARGET_LANGUAGE,
        provider: items.provider || BG_DEFAULT_PROVIDER,
        providerModels: items.providerModels || {},
        providerApiKeys: items.providerApiKeys || {},
        translationUiState: items.translationUiState || {}
      });
    }
  );
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === "loading" || typeof changeInfo.url === "string") {
    clearTabTranslationUiState(tabId).catch(() => {});
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  clearTabTranslationUiState(tabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  if (!request || !request.type) {
    return;
  }

  const handlers = {
    startTranslation: () => handleStartTranslation(request, sendResponse),
    getActiveTranslationState: () => handleGetTranslationState(sendResponse),
    translateSubtitles: () => handleTranslateSubtitles(request, sendResponse)
  };

  const handler = handlers[request.type];

  if (handler) {
    handler();
    return true;
  }
});

async function handleStartTranslation(request, sendResponse) {
  let tab = null;
  let settings = null;
  let targetLanguage = BG_DEFAULT_TARGET_LANGUAGE;

  try {
    settings = await getStoredTranslationSettings();
    targetLanguage = request.targetLanguage || settings.targetLanguage || BG_DEFAULT_TARGET_LANGUAGE;
    tab = await queryActiveTab();

    if (!tab || typeof tab.id === "undefined") {
      throw new Error("Active tab not found.");
    }

    await setTabTranslationUiState(tab, {
      status: "running",
      message: buildTranslationStateMessage("running")
    });

    await triggerTranslationForActiveTab(tab, targetLanguage, settings);
    await setTabTranslationUiState(tab, {
      status: "applied",
      message: buildTranslationStateMessage("applied")
    });
    sendResponse({ ok: true });
  } catch (error) {
    if (tab && typeof tab.id !== "undefined") {
      await setTabTranslationUiState(tab, {
        status: "error",
        message: `${buildTranslationStateMessage("error")} ${error.message || "Translation failed."}`.trim()
      });
    }

    sendResponse({ ok: false, error: error.message });
  }
}

function handleGetTranslationState(sendResponse) {
  getActiveTabTranslationState()
    .then((state) => sendResponse({ ok: true, state }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
}

function handleTranslateSubtitles(request, sendResponse) {
  translateWithProvider(request.payload)
    .then((data) => {
      sendResponse({
        ok: true,
        translations: data.translations,
        mode: data.mode,
        tokenInfo: data.tokenInfo
      });
    })
    .catch((error) => sendResponse({ ok: false, error: error.message }));
}

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs.length ? tabs[0] : null);
    });
  });
}

async function triggerTranslationForActiveTab(tab, targetLanguage, settings) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tab.id,
      {
        type: "translateCurrentVideo",
        targetLanguage,
        provider: settings.provider,
        model: settings.model,
        apiKey: settings.apiKey
      },
      (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error("Page is not ready. Refresh the video page and try again."));
          return;
        }

        if (!response || !response.ok) {
          reject(new Error((response && response.error) || "Failed to start translation."));
          return;
        }

        resolve();
      }
    );
  });
}

async function getActiveTabTranslationState() {
  const tab = await queryActiveTab();

  if (!tab || typeof tab.id === "undefined") {
    throw new Error("Active tab not found.");
  }

  const storedState = await getTabTranslationUiState(tab);

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { type: "getTranslationState" }, (response) => {
      if (chrome.runtime.lastError) {
        resolve({
          applied: storedState.status === "applied",
          inProgress: storedState.status === "running",
          status: storedState.status || "idle",
          message: storedState.message || ""
        });
        return;
      }

      if (!response || !response.ok) {
        resolve({
          applied: storedState.status === "applied",
          inProgress: storedState.status === "running",
          status: storedState.status || "idle",
          message: storedState.message || (response && response.error) || ""
        });
        return;
      }

      const applied = !!response.applied;
      const inProgress = !!response.inProgress;
      const resolvedStatus = applied
        ? "applied"
        : inProgress
          ? "running"
          : storedState.status || "idle";

      resolve({
        applied,
        inProgress,
        status: resolvedStatus,
        message:
          storedState.message ||
          (applied
            ? "Translation is already applied for this video."
            : inProgress
              ? "Translation is in progress."
              : "")
      });
    });
  });
}

async function translateWithProvider(payload) {
  await ensureTranslatorCoreReady();

  const body = {
    segments: (payload && payload.segments) || [],
    sourceLanguage: (payload && payload.sourceLanguage) || "auto",
    targetLanguage: (payload && payload.targetLanguage) || BG_DEFAULT_TARGET_LANGUAGE,
    provider: (payload && payload.provider) || BG_DEFAULT_PROVIDER,
    model: payload && payload.model ? payload.model : "",
    apiKey: payload && payload.apiKey ? payload.apiKey : ""
  };

  const data = await self.TranslatorCore.translateRequest(body);

  if (!data || !Array.isArray(data.translations)) {
    throw new Error("Translator returned an invalid response.");
  }

  return data;
}

function ensureTranslatorCoreReady() {
  if (!translatorCoreInitPromise) {
    if (!self.TranslatorCore || typeof self.TranslatorCore.initialize !== "function") {
      throw new Error("Translator runtime failed to load.");
    }

    translatorCoreInitPromise = self.TranslatorCore.initialize();
  }

  return translatorCoreInitPromise;
}

async function getStoredTranslationSettings() {
  const localItems = await storageGet("local", {
    targetLanguage: BG_DEFAULT_TARGET_LANGUAGE,
    provider: BG_DEFAULT_PROVIDER,
    providerModels: {},
    providerApiKeys: {}
  });
  const provider = normalizeProvider(localItems.provider);
  const providerModels = localItems.providerModels || {};
  const providerApiKeys = localItems.providerApiKeys || {};

  return {
    targetLanguage: localItems.targetLanguage || BG_DEFAULT_TARGET_LANGUAGE,
    provider,
    model: providerModels[provider] || BG_PROVIDER_DEFAULT_MODELS[provider] || BG_PROVIDER_DEFAULT_MODELS[BG_DEFAULT_PROVIDER],
    apiKey: providerApiKeys[provider] || ""
  };
}

function normalizeProvider(value) {
  const provider = String(value || "").trim().toLowerCase();
  return BG_PROVIDER_DEFAULT_MODELS[provider] ? provider : BG_DEFAULT_PROVIDER;
}

function storageGet(area, defaults) {
  return new Promise((resolve) => {
    chrome.storage[area].get(defaults, resolve);
  });
}

function storageSet(area, values) {
  return new Promise((resolve, reject) => {
    chrome.storage[area].set(values, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "Storage write failed."));
        return;
      }

      resolve();
    });
  });
}

async function getTabTranslationUiState(tab) {
  const items = await storageGet("local", { [BG_TRANSLATION_UI_STATE_KEY]: {} });
  const allStates = items[BG_TRANSLATION_UI_STATE_KEY] || {};
  const state = allStates[String(tab.id)];

  if (!state || state.pageUrl !== (tab.url || "")) {
    return { status: "idle", message: "" };
  }

  return {
    status: state.status || "idle",
    message: state.message || ""
  };
}

async function setTabTranslationUiState(tab, nextState) {
  const items = await storageGet("local", { [BG_TRANSLATION_UI_STATE_KEY]: {} });
  const allStates = items[BG_TRANSLATION_UI_STATE_KEY] || {};

  allStates[String(tab.id)] = {
    pageUrl: tab.url || "",
    status: nextState.status || "idle",
    message: nextState.message || "",
    updatedAt: Date.now()
  };

  await storageSet("local", { [BG_TRANSLATION_UI_STATE_KEY]: allStates });
}

async function clearTabTranslationUiState(tabId) {
  const key = String(tabId);
  const items = await storageGet("local", { [BG_TRANSLATION_UI_STATE_KEY]: {} });
  const allStates = items[BG_TRANSLATION_UI_STATE_KEY] || {};

  if (!Object.prototype.hasOwnProperty.call(allStates, key)) {
    return;
  }

  delete allStates[key];
  await storageSet("local", { [BG_TRANSLATION_UI_STATE_KEY]: allStates });
}

function buildTranslationStateMessage(status) {
  if (status === "running") {
    return "Translation is in progress.";
  }

  if (status === "applied") {
    return "Translation applied successfully.";
  }

  if (status === "error") {
    return "Translation failed.";
  }

  return "";
}
