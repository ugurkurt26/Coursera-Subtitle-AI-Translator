# Coursera Subtitle AI Translator

Translate Coursera subtitles with Gemini, ChatGPT, Claude, or DeepSeek.

## Privacy

- API keys are stored only in your local Chrome profile with `chrome.storage.local`.
- The extension does not upload your keys to a separate backend or external database.
- Requests are sent directly from the extension to the provider you selected.

## What It Does

- Translates Coursera subtitles inside the video player.
- Shows translated subtitles in the Coursera player.
- Saves your selected provider, model, and API key in the extension.
- Keeps technical terms more stable than a plain word-by-word translation.

## Requirements

- Chrome or another Chromium-based browser
- A Coursera video page with subtitles
- An API key for one of these providers:
  - Gemini
  - ChatGPT
  - Anthropic
  - DeepSeek

## Install

1. Open `chrome://extensions`
2. Turn on `Developer mode`
3. Click `Load unpacked`
4. Select this project folder

## Use

1. Open a Coursera video page.
2. Make sure the page has loaded its subtitle download link.
3. Click the extension icon.
4. Choose the target language.
5. Choose a provider.
6. Enter your model and API key.
7. Click `Save Provider Settings`.
8. Click `Translate Subtitles`.

## Settings

- Provider, model, and API key are stored locally in Chrome.
- Saved settings are reused automatically.
- API keys are stored separately for each provider.
- You can use the preset model list or type a custom model id.

## Supported Providers

- Gemini
- ChatGPT
- Anthropic
- DeepSeek

## Notes

- The source subtitle language is treated as English.
- The translated subtitles appear as a separate AI subtitle option instead of replacing Coursera's built-in subtitle list.

## Common Issues

### `VTT subtitle download link not found`

Scroll the page a bit and make sure the video page has fully loaded.

### `Failed to communicate with the extension`

Refresh the Coursera page and try again.

### Provider API error

Check the API key, selected model, quota, and billing status for that provider.

### The AI subtitle option does not appear

Reload the extension from `chrome://extensions`, refresh the Coursera page, and run translation again.

## Files You May Want To Edit

- [`prompt-rules.json`](prompt-rules.json) for translation rules
- [`tech_terms_dictionary.json`](tech_terms_dictionary.json) for protected technical terms
- [`popup.js`](popup.js) if you want to change provider or model options

## License

[MIT](LICENSE)
