# Coursera Subtitle AI Translator

Chrome MV3 extension with a local Gemini proxy for translating course subtitles while preserving technical terms and cue timing.

## Overview

This project translates subtitle cues on online course video pages from the available source subtitle language into a selected target language.
Translation is handled by a local Node.js proxy that calls the Gemini API and applies language-specific prompt rules.

## Repository Structure

- `manifest.json`: Chrome extension manifest (MV3)
- `popup.html`, `popup.js`, `popup.css`: extension popup UI
- `background.js`: extension background/service-worker message flow
- `content.js`: subtitle extraction, grouping, and in-page cue replacement
- `gemini-proxy.js`: local HTTP proxy for Gemini translation
- `prompt-rules.json`: per-language translation instructions
- `tech_terms_dictionary.json`: English technical term source used for protection

## Requirements

- Node.js 18 or newer
- Gemini API key (`GEMINI_API_KEY`)
- Chrome or another Chromium-based browser

## Setup

1. Go to the project folder:
```bash
cd <project-directory>
```

2. Export your Gemini key:
```bash
export GEMINI_API_KEY="YOUR_KEY"
```

3. Start the local proxy:
```bash
node gemini-proxy.js
```

4. Load the extension:
1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this project directory

## How It Works

1. The popup sends a translation request to the active video tab.
2. The content script collects subtitle cues and builds sentence groups.
3. The background script sends grouped text to `http://127.0.0.1:8787/translate`.
4. The proxy translates with Gemini (single request or chunked mode).
5. Translated text is written back to cues while preserving playback timing.

## Configuration

Environment variables accepted by `gemini-proxy.js`:

- `GEMINI_API_KEY` (required)
- `GEMINI_MODEL` (optional, default is defined in code)
- `GEMINI_PROXY_PORT` (optional, default: `8787`)
- `PROMPT_RULES_SOURCE` (optional path/URL override)
- `CHUNK_CHAR_LIMIT` (optional)
- `CHUNK_CONTEXT_WINDOW` (optional)
- `PARALLEL_CHUNK_CONCURRENCY` (optional)

## Customization

- Edit `prompt-rules.json` to change translation behavior per target language.
- Replace `tech_terms_dictionary.json` if you want a different technical glossary.

## Troubleshooting

- `GEMINI_API_KEY is missing`: key is not exported in the shell/session running the proxy.
- `Gemini proxy did not return a valid response`: verify proxy logs and model access.
- Extension cannot start translation: check that proxy is running and reachable on `127.0.0.1:8787`.
- No subtitle changes on page: refresh the video page and try again.

## Development Notes

- Extension code is plain JavaScript (no build step required).
- Proxy uses native `fetch` from Node.js runtime.
- Keep proxy running while using the extension.
- Current domain target in `manifest.json`: `www.coursera.org` (can be changed).
