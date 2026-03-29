const DEFAULT_TARGET_LANGUAGE = "tr";

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

const languageSelect = document.getElementById("languageSelect");
const translateButton = document.getElementById("translateButton");
const buttonLabel = document.getElementById("buttonLabel");
const statusText = document.getElementById("statusText");
const progressContainer = document.getElementById("progressContainer");
const progressFill = document.getElementById("progressFill");
const progressText = document.getElementById("progressText");

initializePopup();

function initializePopup() {
  renderLanguageOptions();
  restoreSavedLanguage();
  refreshTranslationState();
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

function restoreSavedLanguage() {
  chrome.storage.sync.get({ targetLanguage: DEFAULT_TARGET_LANGUAGE }, (items) => {
    languageSelect.value = items.targetLanguage || DEFAULT_TARGET_LANGUAGE;
  });
}

function refreshTranslationState() {
  setButtonIdle();
  setStatus("", "");

  chrome.runtime.sendMessage({ type: "getActiveTranslationState" }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ok) {
      setStatus("Could not read translation state. Refresh the page.", "error");
      return;
    }

    const state = response.state || {};

    if (state.applied) {
      setButtonApplied();
      setStatus("Translation is already applied for this video.", "success");
      return;
    }

    if (state.inProgress) {
      setButtonBusy("Translating...");
      showProgress(true);
      setStatus("Translation is in progress.", "");
    }
  });
}

function onTranslateClick() {
  const targetLanguage = languageSelect.value || DEFAULT_TARGET_LANGUAGE;

  setButtonBusy("Downloading VTT...");
  showProgress(true);
  setStatus("Downloading subtitle file and starting translation...", "");

  chrome.storage.sync.set({ targetLanguage }, () => {
    chrome.runtime.sendMessage(
      { type: "startTranslation", targetLanguage },
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
  });
}

function setButtonIdle() {
  translateButton.disabled = false;
  translateButton.classList.remove("applied");
  buttonLabel.textContent = "Translate Subtitles";
}

function setButtonBusy(label) {
  translateButton.disabled = true;
  translateButton.classList.remove("applied");
  buttonLabel.textContent = label || "Translating...";
}

function setButtonApplied() {
  translateButton.disabled = true;
  translateButton.classList.add("applied");
  buttonLabel.textContent = "Translation Applied";
}

function setStatus(message, type) {
  statusText.textContent = message;
  statusText.className = "status";

  if (type) {
    statusText.classList.add(type);
  }
}

function showProgress(indeterminate) {
  progressContainer.hidden = false;
  progressFill.style.width = indeterminate ? "" : "0%";
  progressFill.classList.toggle("indeterminate", !!indeterminate);
  progressText.textContent = indeterminate ? "Processing..." : "";
}

function hideProgress() {
  progressFill.classList.remove("indeterminate");
  progressFill.style.width = "100%";
  progressText.textContent = "Done";

  setTimeout(() => {
    progressContainer.hidden = true;
    progressFill.style.width = "0%";
    progressText.textContent = "";
  }, 800);
}
