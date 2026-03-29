const DEFAULT_TARGET_LANGUAGE = "tr";
const DEFAULT_PROVIDER = "gemini";

const LANGUAGES = [
  { code: "tr", label: "Turkish" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
  { code: "pt", label: "Portuguese" },
  { code: "it", label: "Italian" },
  { code: "ar", label: "Arabic" },
  { code: "ru", label: "Russian" },
  { code: "ja", label: "Japanese" },
  { code: "ko", label: "Korean" },
  { code: "zh", label: "Chinese (Simplified)" },
  { code: "hi", label: "Hindi" },
  { code: "id", label: "Indonesian" }
];

const PROVIDERS = [
  {
    code: "gemini",
    label: "Gemini",
    defaultModel: "gemini-3.1-flash-lite-preview",
    models: [
      { value: "gemini-3.1-flash-lite-preview", label: "gemini-3.1-flash-lite-preview" },
      { value: "gemini-3-flash-preview", label: "gemini-3-flash-preview" },
      { value: "gemini-3-pro-preview", label: "gemini-3-pro-preview" },
      { value: "gemini-2.5-flash-lite", label: "gemini-2.5-flash-lite" },
      { value: "gemini-2.5-flash", label: "gemini-2.5-flash" },
      { value: "gemini-2.5-pro", label: "gemini-2.5-pro" }
    ],
    keyHint: "Stored locally in Chrome and reused automatically on later translations."
  },
  {
    code: "openai",
    label: "ChatGPT",
    defaultModel: "gpt-5.4-mini",
    models: [
      { value: "gpt-5.4-nano", label: "gpt-5.4-nano" },
      { value: "gpt-5.4-mini", label: "gpt-5.4-mini" },
      { value: "gpt-4.1-mini", label: "gpt-4.1-mini" },
      { value: "gpt-4.1", label: "gpt-4.1" },
      { value: "gpt-5.4", label: "gpt-5.4" },
      { value: "gpt-5.4-pro", label: "gpt-5.4-pro" }
    ],
    keyHint: "Stored locally in Chrome and reused automatically on later translations."
  },
  {
    code: "anthropic",
    label: "Claude",
    defaultModel: "claude-sonnet-4-20250514",
    models: [
      { value: "claude-3-5-haiku-20241022", label: "claude-3-5-haiku-20241022" },
      { value: "claude-sonnet-4-20250514", label: "claude-sonnet-4-20250514" },
      { value: "claude-opus-4-1-20250805", label: "claude-opus-4-1-20250805" }
    ],
    keyHint: "Stored locally in Chrome and reused automatically on later translations."
  },
  {
    code: "deepseek",
    label: "DeepSeek",
    defaultModel: "deepseek-chat",
    models: [
      { value: "deepseek-chat", label: "deepseek-chat" },
      { value: "deepseek-reasoner", label: "deepseek-reasoner" }
    ],
    keyHint: "Stored locally in Chrome and reused automatically on later translations."
  }
];

const languageSelect = document.getElementById("languageSelect");
const providerSelect = document.getElementById("providerSelect");
const modelSelect = document.getElementById("modelSelect");
const customModelInput = document.getElementById("customModelInput");
const apiKeyInput = document.getElementById("apiKeyInput");
const apiKeyHint = document.getElementById("apiKeyHint");
const saveSettingsButton = document.getElementById("saveSettingsButton");
const translateButton = document.getElementById("translateButton");
const buttonLabel = document.getElementById("buttonLabel");
const statusText = document.getElementById("statusText");
const progressContainer = document.getElementById("progressContainer");
const progressFill = document.getElementById("progressFill");
const progressText = document.getElementById("progressText");
let refreshTimerId = null;
let progressHideTimerId = null;
let lastButtonState = { mode: "", label: "" };
let lastStatusState = { message: "", type: "" };
let lastProgressState = { visible: false, indeterminate: false, text: "", width: "0%" };

const providerModels = {};
const providerApiKeys = {};
let activeProviderCode = DEFAULT_PROVIDER;

initializePopup().catch((error) => {
  setStatus(error.message || "Failed to initialize popup.", "error");
});

async function initializePopup() {
  renderLanguageOptions();
  renderProviderOptions();
  await restoreSavedSettings();
  refreshProviderFields();
  await refreshTranslationState();
  startTranslationStatePolling();

  providerSelect.addEventListener("change", onProviderChange);
  modelSelect.addEventListener("change", onModelSelectionChange);
  saveSettingsButton.addEventListener("click", onSaveSettingsClick);
  translateButton.addEventListener("click", onTranslateClick);
}

function renderLanguageOptions() {
  for (const lang of LANGUAGES) {
    const option = document.createElement("option");
    option.value = lang.code;
    option.textContent = lang.label;
    languageSelect.appendChild(option);
  }
}

function renderProviderOptions() {
  for (const provider of PROVIDERS) {
    const option = document.createElement("option");
    option.value = provider.code;
    option.textContent = provider.label;
    providerSelect.appendChild(option);
  }
}

async function restoreSavedSettings() {
  const localItems = await storageGet("local", {
    targetLanguage: DEFAULT_TARGET_LANGUAGE,
    provider: DEFAULT_PROVIDER,
    providerModels: {},
    providerApiKeys: {}
  });

  languageSelect.value = localItems.targetLanguage || DEFAULT_TARGET_LANGUAGE;
  providerSelect.value = localItems.provider || DEFAULT_PROVIDER;

  Object.assign(providerModels, localItems.providerModels || {});
  Object.assign(providerApiKeys, localItems.providerApiKeys || {});
  activeProviderCode = providerSelect.value || DEFAULT_PROVIDER;
}

function onProviderChange() {
  persistProviderDraft(activeProviderCode);
  activeProviderCode = getSelectedProviderCode();
  refreshProviderFields();
  setStatus("", "");
}

function onModelSelectionChange() {
  const customSelected = modelSelect.value === "__custom__";
  customModelInput.hidden = !customSelected;

  if (customSelected) {
    customModelInput.focus();
  }
}

async function onSaveSettingsClick() {
  await persistCurrentSettings();
  setStatus("Provider settings saved.", "success");
}

async function onTranslateClick() {
  const provider = getSelectedProviderCode();
  const apiKey = apiKeyInput.value.trim();

  if (!apiKey) {
    setStatus(`${getSelectedProvider().label} API key is required. Save it in the popup before translating.`, "error");
    return;
  }

  setButtonBusy("Downloading VTT...");
  showProgress(true);
  setStatus("Saving settings, downloading subtitle file, and starting translation...", "");

  try {
    await persistCurrentSettings();
  } catch (error) {
    hideProgress();
    setButtonIdle();
    setStatus(error.message || "Failed to save provider settings.", "error");
    return;
  }

  chrome.runtime.sendMessage(
    { type: "startTranslation", targetLanguage: languageSelect.value || DEFAULT_TARGET_LANGUAGE },
    (response) => {
      hideProgress();

      if (chrome.runtime.lastError) {
        setButtonIdle();
        setStatus("Failed to communicate with the extension.", "error");
        return;
      }

      if (!response || !response.ok) {
        const message = (response && response.error) || "Translation failed.";

        if (/already/i.test(message)) {
          setButtonApplied();
        } else {
          setButtonIdle();
        }

        setStatus(message, "error");
        return;
      }

      setButtonApplied();
      setStatus("Translation applied successfully.", "success");
    }
  );
}

async function persistCurrentSettings() {
  const provider = getSelectedProviderCode();
  persistProviderDraft(provider);
  const model = getSelectedModelValue(provider);
  const apiKey = apiKeyInput.value.trim();

  providerModels[provider] = model;
  providerApiKeys[provider] = apiKey;

  await storageSet("local", {
    targetLanguage: languageSelect.value || DEFAULT_TARGET_LANGUAGE,
    provider,
    providerModels,
    providerApiKeys
  });
  refreshProviderFields();
}

function refreshProviderFields() {
  const provider = getSelectedProvider();
  const providerCode = provider.code;
  const savedModel = providerModels[providerCode] || provider.defaultModel;

  renderModelOptions(provider);
  syncModelInputs(savedModel, provider);
  apiKeyInput.value = providerApiKeys[providerCode] || "";
  apiKeyInput.placeholder = buildApiKeyPlaceholder(providerCode);
  apiKeyHint.textContent = provider.keyHint;
}

function persistProviderDraft(provider) {
  if (!provider) {
    return;
  }

  providerModels[provider] = getSelectedModelValue(provider);
  providerApiKeys[provider] = apiKeyInput.value.trim();
}

function renderModelOptions(provider) {
  modelSelect.textContent = "";

  for (const model of provider.models || []) {
    const option = document.createElement("option");
    option.value = model.value;
    option.textContent = model.label;
    modelSelect.appendChild(option);
  }

  const customOption = document.createElement("option");
  customOption.value = "__custom__";
  customOption.textContent = "Custom model...";
  modelSelect.appendChild(customOption);
}

function syncModelInputs(modelValue, provider) {
  const selectedModel = String(modelValue || "").trim() || provider.defaultModel;
  const knownModel = (provider.models || []).some((item) => item.value === selectedModel);

  if (knownModel) {
    modelSelect.value = selectedModel;
    customModelInput.value = "";
    customModelInput.hidden = true;
    return;
  }

  modelSelect.value = "__custom__";
  customModelInput.value = selectedModel;
  customModelInput.placeholder = provider.defaultModel;
  customModelInput.hidden = false;
}

function getSelectedModelValue(providerCode) {
  const provider = PROVIDERS.find((item) => item.code === providerCode) || PROVIDERS[0];

  if (modelSelect.value === "__custom__") {
    return customModelInput.value.trim() || provider.defaultModel;
  }

  return modelSelect.value || provider.defaultModel;
}

function buildApiKeyPlaceholder(providerCode) {
  if (providerCode === "openai") {
    return "sk-...";
  }

  if (providerCode === "anthropic") {
    return "sk-ant-...";
  }

  if (providerCode === "deepseek") {
    return "DeepSeek API key";
  }

  return "Gemini API key";
}

function getProviderDefaultModel(providerCode) {
  return (PROVIDERS.find((item) => item.code === providerCode) || PROVIDERS[0]).defaultModel;
}

function getSelectedProviderCode() {
  return providerSelect.value || DEFAULT_PROVIDER;
}

function getSelectedProvider() {
  return PROVIDERS.find((item) => item.code === getSelectedProviderCode()) || PROVIDERS[0];
}

function refreshTranslationState() {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: "getActiveTranslationState" }, (response) => {
      if (chrome.runtime.lastError || !response || !response.ok) {
        hideProgress();
        setStatus("Could not read translation state. Refresh the page.", "error");
        resolve();
        return;
      }

      const state = response.state || {};

      if (state.applied || state.status === "applied") {
        hideProgress();
        setButtonApplied();
        setStatus(state.message || "Translation is already applied for this video.", "success");
        resolve();
        return;
      }

      if (state.inProgress || state.status === "running") {
        setButtonBusy("Translating...");
        showProgress(true);
        setStatus(state.message || "Translation is in progress.", "");
        resolve();
        return;
      }

      hideProgress();
      setButtonIdle();

      if (state.status === "error" && state.message) {
        setStatus(state.message, "error");
      } else if (state.message) {
        setStatus(state.message, "");
      }

      resolve();
    });
  });
}

function startTranslationStatePolling() {
  if (refreshTimerId) {
    clearInterval(refreshTimerId);
  }

  refreshTimerId = window.setInterval(() => {
    refreshTranslationState().catch(() => {});
  }, 1500);
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

function setButtonIdle() {
  updateButtonState("idle", "Translate Subtitles");
}

function setButtonBusy(label) {
  updateButtonState("busy", label || "Translating...");
}

function setButtonApplied() {
  updateButtonState("applied", "Translation Applied");
}

function setStatus(message, type) {
  const nextMessage = message || "";
  const nextType = type || "";

  if (lastStatusState.message === nextMessage && lastStatusState.type === nextType) {
    return;
  }

  statusText.textContent = nextMessage;
  statusText.className = "status";

  if (nextType) {
    statusText.classList.add(nextType);
  }

  lastStatusState = { message: nextMessage, type: nextType };
}

function showProgress(indeterminate) {
  const nextText = indeterminate ? "Processing..." : "";
  const nextWidth = indeterminate ? "" : "0%";

  if (progressHideTimerId) {
    clearTimeout(progressHideTimerId);
    progressHideTimerId = null;
  }

  if (
    lastProgressState.visible &&
    lastProgressState.indeterminate === !!indeterminate &&
    lastProgressState.text === nextText &&
    lastProgressState.width === nextWidth
  ) {
    return;
  }

  progressContainer.hidden = false;
  progressFill.style.width = nextWidth;
  progressFill.classList.toggle("indeterminate", !!indeterminate);
  progressText.textContent = nextText;
  lastProgressState = {
    visible: true,
    indeterminate: !!indeterminate,
    text: nextText,
    width: nextWidth
  };
}

function hideProgress() {
  if (!lastProgressState.visible) {
    return;
  }

  progressFill.classList.remove("indeterminate");
  progressFill.style.width = "100%";
  progressText.textContent = "Done";

  if (progressHideTimerId) {
    clearTimeout(progressHideTimerId);
  }

  progressHideTimerId = setTimeout(() => {
    progressContainer.hidden = true;
    progressFill.style.width = "0%";
    progressText.textContent = "";
    lastProgressState = { visible: false, indeterminate: false, text: "", width: "0%" };
    progressHideTimerId = null;
  }, 800);
}

function updateButtonState(mode, label) {
  if (lastButtonState.mode === mode && lastButtonState.label === label) {
    return;
  }

  translateButton.disabled = mode !== "idle";
  translateButton.classList.toggle("applied", mode === "applied");
  buttonLabel.textContent = label;
  lastButtonState = { mode, label };
}
