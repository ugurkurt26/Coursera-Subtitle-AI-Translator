# Coursera Subtitle AI Translator

A Chrome extension that translates Coursera video subtitles using AI-powered semantic grouping. It downloads the WebVTT subtitle file directly from the page, groups cues into coherent semantic units, and translates them through a local Gemini proxy — preserving meaning across sentence boundaries.

## Features

- **Semantic grouping** — Cues are merged into translation units based on timestamp gaps and sentence boundaries, so multi-cue thoughts are translated together instead of fragment-by-fragment.
- **VTT-first approach** — Downloads the official WebVTT file from Coursera's Downloads section for reliable, timestamp-aware processing.
- **Technical term protection** — English technical terms, acronyms, CLI commands, and code identifiers are detected and shielded from mistranslation.
- **Language-specific rules** — Per-language prompt rules handle suffix morphology (Turkish), gender agreement (French/Spanish), case governance (German/Russian), and more.
- **13 target languages** — Turkish, Spanish, French, German, Portuguese, Italian, Arabic, Russian, Japanese, Korean, Chinese, Hindi, Indonesian.
- **Smart chunking** — Large transcripts are automatically split into chunks with sliding context windows, translated in parallel, and reassembled in order.

## Architecture

```
┌──────────────┐      ┌────────────────┐      ┌───────────────────┐
│  popup.html  │─────▶│  background.js │─────▶│  gemini-proxy.js  │
│  popup.js    │ msg  │  (service wkr) │ HTTP │  (localhost:8787) │
└──────────────┘      └───────┬────────┘      └────────┬──────────┘
                              │ msg                     │ REST
                      ┌───────▼────────┐      ┌────────▼──────────┐
                      │   content.js   │      │   Gemini API      │
                      │ (coursera tab) │      │  (cloud)          │
                      └────────────────┘      └───────────────────┘
```

**Data flow:**

1. User clicks **Translate Subtitles** in the popup.
2. `background.js` relays the request to `content.js` running in the active Coursera tab.
3. `content.js` finds the VTT download link in the page DOM, fetches the file, parses it, and builds semantic groups.
4. Grouped segments are sent to `background.js`, which forwards them to the local Gemini proxy.
5. `gemini-proxy.js` assembles a language-aware prompt (with protected terms and per-language rules), calls the Gemini API, and returns translations.
6. `content.js` maps translated text back to the video player's TextTrack cues by timestamp matching.

## Requirements

| Dependency | Version |
|---|---|
| Node.js | 18+ |
| Chrome / Chromium | 116+ (Manifest V3) |
| Gemini API key | [Get one here](https://aistudio.google.com/apikey) |

## Setup

### 1. Clone the repository

```bash
git clone https://github.com/your-username/coursera-subtitle-translate-extension.git
cd coursera-subtitle-translate-extension
```

### 2. Start the local proxy

```bash
export GEMINI_API_KEY="your-api-key"
node gemini-proxy.js
```

You should see:

```
[...] [INFO] Proxy ready at http://127.0.0.1:8787
[...] [INFO] Model: gemini-2.5-flash
```

### 3. Load the extension in Chrome

1. Navigate to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select this project directory

### 4. Translate a video

1. Open any Coursera video lecture page.
2. Make sure the **Downloads** section is visible on the page (it contains the VTT subtitle link).
3. Click the extension icon and select your target language.
4. Click **Translate Subtitles**.

## Configuration

### Environment variables

All optional unless noted.

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | *(required)* | Your Gemini API key |
| `GEMINI_MODEL` | `gemini-2.5-flash` | Gemini model identifier |
| `GEMINI_PROXY_PORT` | `8787` | Local proxy port |
| `CHUNK_CHAR_LIMIT` | `8000` | Max characters per translation chunk |
| `CHUNK_CONTEXT_WINDOW` | `4` | Number of preceding segments sent as context |
| `PARALLEL_CHUNK_CONCURRENCY` | `2` | Parallel Gemini API calls for chunked mode |
| `PROMPT_RULES_SOURCE` | `prompt-rules.json` | Path or URL to custom prompt rules |

### Customization

- **Translation behavior** — Edit [`prompt-rules.json`](prompt-rules.json) to add/modify per-language rules, style guidelines, or prompt templates.
- **Technical glossary** — Replace [`tech_terms_dictionary.json`](tech_terms_dictionary.json) with your own term list. Supports both `{ "terms": [{ "en": "..." }] }` and `{ "always_protect": [...], "candidate_terms": [...] }` formats.

## Project Structure

```
├── manifest.json              # Chrome MV3 extension manifest
├── popup.html                 # Extension popup UI
├── popup.css                  # Popup styles
├── popup.js                   # Popup logic and state management
├── background.js              # Service worker — message routing
├── content.js                 # VTT download, parsing, semantic grouping, cue replacement
├── gemini-proxy.js            # Local Node.js proxy — prompt assembly, Gemini API, chunking
├── prompt-rules.json          # Per-language translation rules and prompt template
├── tech_terms_dictionary.json # Technical term glossary for term protection
└── LICENSE                    # MIT License
```

## How Semantic Grouping Works

Traditional subtitle translators process each cue independently, which breaks sentences that span multiple cues. This extension uses a three-signal approach:

| Signal | Behavior |
|---|---|
| **Timestamp gap** (> 1.5 s) | Always starts a new group — natural speech pauses indicate topic boundaries |
| **Sentence boundary** + min size (80 chars) | Splits at sentence ends when the group has accumulated enough context |
| **Max size** (500 chars) | Soft limit — breaks at the next sentence end. Hard limit at 750 chars |

This means a thought like *"In this video, we're going to be talking about an intro to Threads and / Multithreading."* (split across two cues) gets translated as a single unit.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "VTT subtitle download link not found" | Downloads section not rendered | Scroll down on the video page to load the Downloads section |
| "Failed to communicate with the extension" | Content script not injected | Refresh the Coursera page and try again |
| "Gemini proxy did not return a valid response" | Proxy not running or model error | Check terminal for proxy logs, verify `GEMINI_API_KEY` |
| Subtitles unchanged after translation | TextTrack mismatch | Ensure the video has English subtitles enabled |

## License

[MIT](LICENSE)
