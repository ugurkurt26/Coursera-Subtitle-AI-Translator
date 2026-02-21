const DEFAULT_TARGET_LANGUAGE = "tr";
const TRANSLATE_ENDPOINT = "http://127.0.0.1:8787/translate";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.sync.get({ targetLanguage: DEFAULT_TARGET_LANGUAGE }, (items) => {
    if (!items.targetLanguage) {
      chrome.storage.sync.set({ targetLanguage: DEFAULT_TARGET_LANGUAGE });
    }
  });
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || !request.type) {
    return;
  }

  if (request.type === "startTranslation") {
    const targetLanguage = request.targetLanguage || DEFAULT_TARGET_LANGUAGE;

    triggerTranslationForActiveTab(targetLanguage)
      .then(() => {
        sendResponse({ ok: true });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  if (request.type === "getActiveTranslationState") {
    getActiveTabTranslationState()
      .then((state) => {
        sendResponse({ ok: true, state });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }

  if (request.type === "translateSubtitles") {
    translateWithGemini(request.payload)
      .then((data) => {
        sendResponse({
          ok: true,
          translations: data.translations,
          mode: data.mode,
          tokenInfo: data.tokenInfo
        });
      })
      .catch((error) => {
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  }
});

function queryActiveTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs.length ? tabs[0] : null);
    });
  });
}

async function triggerTranslationForActiveTab(targetLanguage) {
  const tab = await queryActiveTab();

  if (!tab || typeof tab.id === "undefined") {
    throw new Error("Active tab not found.");
  }

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(
      tab.id,
      { type: "translateCurrentVideo", targetLanguage },
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

  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tab.id, { type: "getTranslationState" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error("Could not read translation state on this page."));
        return;
      }

      if (!response || !response.ok) {
        reject(new Error((response && response.error) || "Failed to get translation state."));
        return;
      }

      resolve({
        applied: !!response.applied,
        inProgress: !!response.inProgress
      });
    });
  });
}

async function translateWithGemini(payload) {
  const safePayload = {
    segments: (payload && payload.segments) || [],
    sourceLanguage: (payload && payload.sourceLanguage) || "auto",
    targetLanguage: (payload && payload.targetLanguage) || DEFAULT_TARGET_LANGUAGE
  };

  const response = await fetch(TRANSLATE_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(safePayload)
  });

  if (!response.ok) {
    let errorText = "Gemini proxy did not return a valid response.";
    try {
      const errorPayload = await response.json();
      if (errorPayload && errorPayload.error) {
        errorText = errorPayload.error;
      }
    } catch (err) {
      // Keep default message.
    }
    throw new Error(errorText);
  }

  const data = await response.json();
  if (!data || !Array.isArray(data.translations)) {
    throw new Error("Gemini proxy returned an invalid response.");
  }

  return data;
}
