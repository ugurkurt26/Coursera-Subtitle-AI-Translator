const DEFAULT_TARGET_LANGUAGE = "tr";
const DEFAULT_BUTTON_TEXT = "Translate Video";
const APPLIED_BUTTON_TEXT = "Translation Applied";

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
  { code: "zh", label: "Chinese" },
  { code: "hi", label: "Hindi" },
  { code: "id", label: "Indonesian" }
];

const languageSelect = document.getElementById("languageSelect");
const translateButton = document.getElementById("translateButton");
const statusText = document.getElementById("statusText");

initializePopup();

function initializePopup() {
  renderLanguageOptions();

  chrome.storage.sync.get({ targetLanguage: DEFAULT_TARGET_LANGUAGE }, (items) => {
    languageSelect.value = items.targetLanguage || DEFAULT_TARGET_LANGUAGE;
  });

  setButtonState(false);
  setStatus("", false);

  chrome.runtime.sendMessage({ type: "getActiveTranslationState" }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ok) {
      setStatus("Could not read translation state. Refresh the page and try again.", true);
      return;
    }

    const state = response.state || {};
    if (state.applied) {
      setButtonState(true);
      setStatus("Translation is already applied for this video.", false);
      return;
    }

    if (state.inProgress) {
      setButtonState(true, "Translating...");
      setStatus("Translation is currently in progress.", false);
    }
  });

  translateButton.addEventListener("click", onTranslateClick);
}

function renderLanguageOptions() {
  languageSelect.innerHTML = "";

  for (const language of LANGUAGES) {
    const option = document.createElement("option");
    option.value = language.code;
    option.textContent = language.label;
    languageSelect.appendChild(option);
  }
}

function setStatus(message, isError) {
  statusText.textContent = message;
  statusText.style.color = isError ? "#b42318" : "#134e29";
}

function setButtonState(applied, customText) {
  translateButton.disabled = applied;
  translateButton.textContent = customText || (applied ? APPLIED_BUTTON_TEXT : DEFAULT_BUTTON_TEXT);
}

function onTranslateClick() {
  const selectedLanguage = languageSelect.value || DEFAULT_TARGET_LANGUAGE;

  setButtonState(true, "Starting...");
  setStatus("Starting translation...", false);

  chrome.storage.sync.set({ targetLanguage: selectedLanguage }, () => {
    chrome.runtime.sendMessage(
      {
        type: "startTranslation",
        targetLanguage: selectedLanguage
      },
      (response) => {
        if (chrome.runtime.lastError) {
          setButtonState(false);
          setStatus("Failed to communicate with the extension.", true);
          return;
        }

        if (!response || !response.ok) {
          const message = (response && response.error) || "Failed to start translation.";
          if (/already/i.test(message)) {
            setButtonState(true);
          } else {
            setButtonState(false);
          }
          setStatus(message, true);
          return;
        }

        setButtonState(true);
        setStatus("Translation applied.", false);
      }
    );
  });
}
