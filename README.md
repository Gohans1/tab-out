# Tab Out

**Keep tabs on your tabs.**

Tab Out is an intelligent Chrome extension that replaces your new tab page with a dashboard of everything you have open. Powered by **Model Jev (OpenRouter)**, tabs are automatically analyzed and categorized into customizable **Perspectives** (Work, Research, Social, Entertainment, etc.), or grouped by domain. Close tabs with a satisfying swoosh + confetti.

Smart AI classification with Model Jev. No centralized servers. You own your API key.

---

## Install with a coding agent

Send your coding agent (Claude Code, Codex, etc.) this repo and say **"install this"**:

```
https://github.com/zarazhangrui/tab-out
```

The agent will walk you through it. Takes about 1 minute.

---

## Features

- **AI-Powered Perspectives (Model Jev)** automatically classifies tabs into contextual groups with custom AI prompts
- **See all your tabs at a glance** on a clean grid, grouped by domain or AI perspective
- **Homepages group** pulls Gmail inbox, X home, YouTube, LinkedIn, GitHub homepages into one card
- **Close tabs with style** with swoosh sound + confetti burst
- **Duplicate detection** flags when you have the same page open twice, with one-click cleanup
- **Click any tab to jump to it** across windows, no new tab opened
- **Save for later** bookmark tabs to a checklist before closing them
- **Localhost grouping** shows port numbers next to each tab so you can tell your vibe coding projects apart
- **Expandable groups** show the first 8 tabs with a clickable "+N more"
- **Client-side intelligence** uses your OpenRouter API key directly with Model Jev

---

## Manual Setup

**1. Clone the repo**

```bash
git clone https://github.com/zarazhangrui/tab-out.git
```

**2. Load the Chrome extension**

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Navigate to the `extension/` folder inside the cloned repo and select it

**3. Open a new tab**

You'll see Tab Out.

---

## How it works

```
You open a new tab
  -> Model Jev classifies your open tabs into smart Perspectives
  -> Or organizes them neatly by domain / homepages
  -> Click any tab title to jump to it
  -> Close groups you're done with (swoosh + confetti)
  -> Save tabs for later before closing them
```

Tab classification is powered by Model Jev via OpenRouter, caching results in `chrome.storage.local`.

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| AI Engine | Model Jev via OpenRouter API |
| Storage | chrome.storage.local |
| Sound | Web Audio API (synthesized, no files) |
| Animations | CSS transitions + JS confetti particles |

---

## License

MIT

---

Built by [Zara](https://x.com/zarazhangrui)
