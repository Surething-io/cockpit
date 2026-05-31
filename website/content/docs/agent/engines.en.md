Cockpit talks to 5 AI engines out of the box (plus a **Claude 2** entry, so 6 picker options total). Each Agent tab picks one engine; you can mix and match across tabs without restarting — pick by what's running locally, what billing account you're on, or which model is best at the task in front of you.

| Engine | How to sign in | When to use |
|---|---|---|
| [Claude](#claude) | Anthropic `claude` CLI login (or **Claude 2** for a second account) | Default. Best general-purpose model. |
| [Codex](#codex) | `codex` CLI login | If you already have a Codex / GPT subscription. |
| [DeepSeek](#deepseek) | Paste API key in the per-tab DeepSeek picker | Strong reasoning at lower cost. |
| [Kimi](#kimi) | `kimi` CLI login | Long context, mostly used in China. |
| [Ollama](#ollama) | Nothing — runs locally | Offline use, sensitive data, custom models. |

> Everything runs locally.

## Overview

### At a glance

| Engine | How to sign in | When to use | Who you pay |
|---|---|---|---|
| **Claude** | Log in once via the `claude` CLI | Default. Best general-purpose model. | Anthropic |
| **Codex** | Log in once via the `codex` CLI | When you already have a Codex / GPT subscription. | OpenAI |
| **DeepSeek** | Paste an API key in the per-tab DeepSeek picker | Strong reasoning at lower cost. | DeepSeek |
| **Kimi** | Log in once via the `kimi` CLI | Long context, mostly used in China. | Moonshot |
| **Ollama** | Nothing — it's local | Offline use, sensitive data, custom models. | Nobody (your own machine) |

The engine picker in each tab also has a **Claude 2** entry — that's the **same engine** as Claude, just pointed at a second config directory (`~/.claude2`) so it uses a *different* Anthropic account. See the [Claude](#claude) section for setup.

### How engine selection works

Each Agent tab has an engine picker in its header. When you create a new tab, the engine defaults to **Claude**. Switching the engine for an existing tab starts a fresh session — Claude history doesn't carry over into a Codex tab, since each engine has its own conversation format.

You can have, say, five tabs open simultaneously:

- Tab 1: Claude on `~/code/backend`
- Tab 2: DeepSeek on the same project for a cheaper second opinion
- Tab 3: Codex on a different project
- Tab 4: Kimi on a notebook with a long PDF attached
- Tab 5: Ollama running a local model for an offline draft

Cockpit's Session Browser (grid icon at the top of the sidebar) shows all of them.

### What each engine can do

|  | Claude | Codex | DeepSeek | Kimi | Ollama |
|---|---|---|---|---|---|
| Can read & edit your files | ✅ | ✅ | ✅ | ✅ | ⚠️ depends on model |
| Accepts image attachments | ✅ | ✅ | ✅ | ❌ | ❌ |
| Streams replies as it thinks | ✅ | ✅ | ✅ | ✅ | ✅ |
| Runs offline | ❌ | ❌ | ❌ | ❌ | ✅ |
| Choose between model variants | Fixed (latest) | Fixed | flash / pro | Fixed | Any model you've pulled |
| Shows running cost in the UI | ✅ | — | ✅ (estimated) | — | Free |

> Image support is engine-level. **Kimi** and **Ollama** tabs **silently drop** image attachments (no error, but the AI doesn't see them).

### Setting up each engine

Per-engine sections below cover the specifics. Quick pointers:

- **Claude** — run `claude` once on your terminal and follow its login prompt. Cockpit reuses your Claude login automatically.
- **Codex** — install OpenAI's `codex` CLI and log in with it once. Cockpit reuses that login.
- **DeepSeek** — get a key from [platform.deepseek.com](https://platform.deepseek.com/), then **paste it in the DeepSeek picker in the Agent tab header** (not in the global Cockpit Settings). Pick a model variant in the same picker.
- **Kimi** — install Moonshot's `kimi` CLI and log in with it once. Cockpit reuses that login.
- **Ollama** — install [Ollama](https://ollama.com/) and pull at least one model (`ollama pull llama3.1`). When you create an Ollama tab, the model picker lists what you've pulled.

## Claude

Claude is Cockpit's default engine — when you start the app and open a new tab, you're talking to Claude unless you pick something else. Cockpit doesn't manage your Claude login; it reuses the `claude` CLI from Anthropic, so anything you've done there (subscriptions, project settings, MCP servers) is available in Cockpit too.

### Setup

You need the Anthropic `claude` CLI installed and logged in.

1. Install Claude Code if you haven't already:

```bash
npm install -g @anthropic-ai/claude-code
```

2. Log in:

```bash
claude
```

The `claude` command walks you through the browser-based login. After it's done, Cockpit picks up your credentials automatically — there's nothing to paste into Cockpit.

That's it. Open Cockpit, create a new Agent tab, start chatting.

### What you get

- The latest Claude model Anthropic recommends, served through the Claude Agent SDK.
- **Image attachments** — paste an image into chat (`Cmd+V`) and Claude can see it. PNG / JPEG / WEBP / GIF up to 5 MB each; you can attach several at once.
- **Tool use** — Claude can read your files, run shell commands, edit code, hit URLs, use MCP tools.
- **Streaming** — replies appear word-by-word as Claude thinks.
- **Cost visible in the UI** — every message shows tokens used and the running USD total per session.

### Use a second Claude account: "Claude 2"

If you have **two** Anthropic accounts — say, one personal and one billed to your company — Cockpit lets you use both at once. The engine picker has two entries: **Claude** and **Claude 2**. They're the **exact same engine**; "Claude 2" just points `CLAUDE_CONFIG_DIR` at `~/.claude2` so the two tabs don't share billing.

Setup for the second account:

1. Open a fresh terminal and tell `claude` to use the second config folder:

```bash
CLAUDE_CONFIG_DIR=~/.claude2 claude
```

2. Log in with your second Anthropic account when prompted.

3. Back in Cockpit, open a tab and pick **Claude 2** in the engine menu. It now talks to that second account.

You can keep one tab on **Claude** (personal) and another on **Claude 2** (work), side by side. Cockpit tracks tokens and cost separately.

> The path has to be **exactly** `~/.claude2` — it's hard-coded in Cockpit. Any other path won't be found. If you only have one Claude account, ignore "Claude 2" entirely.

### Switching models

Cockpit always uses Anthropic's current recommended Claude model. **There is no model picker** — you get the latest the service offers. Watch Anthropic's announcements to know which model is current; Cockpit picks it up automatically when the official SDK updates.

### Common issues

- **"Not logged in" / immediate error on first message** — run `claude` in a terminal and make sure the login completed. Cockpit can only use a login that already works for `claude` on its own.
- **Switching accounts mid-day** — using **Claude 2** is far simpler than logging out and back in.

## Codex

If you have a Codex / ChatGPT subscription, you can drive it from inside Cockpit using the same login. Cockpit doesn't speak the OpenAI API directly here — it `spawn`s OpenAI's `codex` CLI under the hood and shows you its output.

### Setup

1. Install the `codex` CLI from OpenAI (see OpenAI's docs for the current install command — usually a one-liner).

2. Log in:

```bash
codex
```

Follow the prompt to sign in with your OpenAI account.

3. Open Cockpit, create a new Agent tab, pick **Codex** in the engine menu. The tab uses your Codex login.

Nothing to paste inside Cockpit — it reuses whatever `codex` is already configured with on your machine.

### What you get

- The Codex model that ships with your CLI (no in-app picker — whatever your `codex` install gives you).
- **Image attachments** — Cockpit writes pasted images to a temp file and passes them to `codex` via the `--image` flag. PNG / JPEG / WEBP / GIF all work.
- Streaming replies.
- Tool use — Codex can read your files, run shell commands, and edit code.
- Multi-tab sessions — open as many Codex tabs as you need, each independent.

### What you don't get

- **No running cost display.** Cockpit can't read pricing back from the `codex` CLI, so the token bar stays empty for Codex tabs (`total_cost_usd: 0`). Track usage on your OpenAI dashboard instead.
- **No model picker.** Whichever model your `codex` CLI uses is what runs.

### Common issues

- **"`codex` not found" / nothing happens on send** — the `codex` CLI isn't on your PATH. Verify with `codex --version` in a terminal; if that fails, reinstall.
- **Login expired** — re-run `codex` in a terminal and complete the login flow again. Cockpit doesn't manage the login itself.
- **Outdated CLI** — OpenAI updates `codex` periodically. If something behaves oddly, upgrade.

## DeepSeek

DeepSeek is the cheapest cloud engine in Cockpit and the only one besides Claude where you pick a model variant per tab. Unlike Claude / Codex / Kimi (which reuse a CLI's login), DeepSeek is API-key-only — paste a key in the per-tab DeepSeek picker and you're done.

Under the hood it goes through DeepSeek's [Anthropic-compatible endpoint](https://api-docs.deepseek.com/en/guides/anthropic_api) routed via the Claude Agent SDK, so tool use, streaming, and context management all work like Claude.

### Setup

1. Get an API key from [platform.deepseek.com](https://platform.deepseek.com/). It looks like `sk-...`.

2. Open a new tab in Cockpit, pick **DeepSeek** in the engine menu, then **click the DeepSeek picker icon in the tab header** → paste the key → save. (The key lives in `~/.cockpit/settings.json` locally — *not* in the global Cockpit Settings modal.)

3. Pick a model variant in the same picker.

Done. The key only ever stays on your machine.

### Pick a model variant

| Variant | When to use |
|---|---|
| **`deepseek-v4-flash`** (picker shows this as the default) | Fast, cheap. Good for quick fixes, formatting, simple Q&A. |
| **`deepseek-v4-pro`** | Slower, smarter. Use when you need real reasoning — architecture decisions, hard bugs, multi-step refactors. |

> The Claude Agent SDK also uses `deepseek-v4-flash` for background subtasks (title generation, compaction, etc.) regardless of your variant choice.

### What you get

- `flash` or `pro` picked per tab in the dropdown.
- **Image attachments** — paste images (`Cmd+V`) and DeepSeek can see them (via the Anthropic-compatible API).
- Streaming replies.
- Tool use — DeepSeek can read your files, run shell commands, edit code.
- Token counts visible in the UI. *Note: the dollar amount in the token bar is an **estimate** using Cockpit's default per-token prices — it's useful as a relative indicator across sessions; for your actual DeepSeek bill check your DeepSeek dashboard.*

### Common issues

- **"DeepSeek API key is not configured"** — you haven't pasted a key in the picker. The key goes in the **per-tab DeepSeek picker in the header**, not in the global Cockpit Settings modal.
- **"401 / Unauthorized"** — bad or expired key; paste it again in the picker and watch for stray whitespace.
- **Slow / hanging replies** — `pro` is genuinely slower than `flash`; if you don't actually need the reasoning, switch the tab to `flash`.
- **Estimated costs climbing fast** — `pro` is several times more expensive than `flash`. Look at the per-session cost in the token bar to spot accidental `pro` usage.

## Kimi

Kimi is a Chinese-market AI from Moonshot, known for long context windows. Cockpit drives it via Moonshot's `kimi` CLI — install the CLI once, log in, and Cockpit reuses your session.

### Setup

1. Install Moonshot's `kimi` CLI (follow Moonshot's official install instructions for your platform).

2. Log in:

```bash
kimi
```

Follow the prompt to sign in with your Kimi / Moonshot account.

3. Open Cockpit, create a new Agent tab, pick **Kimi** in the engine menu. The tab uses your Kimi login.

Nothing to paste inside Cockpit — it reuses whatever `kimi` is already configured with on your machine.

### What you get

- The Kimi model that ships with the CLI.
- Streaming replies, with **the model's "thinking" steps folded into a `<details>` block before the final answer**.
- Tool use — Kimi can read your files, run shell commands, edit code.
- Multi-tab sessions, each independent.

### What you don't get

- **No image attachments.** Kimi tabs don't accept image input; pasted images are silently dropped.
- **No running cost display.** Cockpit can't read pricing back from the `kimi` CLI. Check your Moonshot dashboard for billing.
- **No model picker.** Whichever model your `kimi` CLI ships with is what runs.

### Common issues

- **"`kimi` not found" / nothing happens on send** — the `kimi` CLI isn't on your PATH. Verify with `kimi --version` in a terminal; if that fails, install it.
- **Login expired** — re-run `kimi` in a terminal and complete the login flow again.
- **Outdated CLI** — Moonshot updates `kimi` periodically. Upgrade per Moonshot's docs if behaviour gets strange.

## Ollama

Ollama is the only engine in Cockpit that runs entirely on your own machine. No API key, no cloud, no per-token cost. Install Ollama, pull the models you want, and Cockpit lists them in the model picker.

Reach for this engine when:

- You're on a plane or otherwise offline.
- You're working with sensitive code that shouldn't leave your laptop.
- You have a workstation with a beefy GPU and want to use it.
- You're experimenting with custom or fine-tuned models.

### Setup

1. Install Ollama from [ollama.com](https://ollama.com/).

2. Pull at least one model:

```bash
ollama pull llama3.1
```

You can pull more later: `ollama pull qwen3.5`, `ollama pull deepseek-coder`, etc. See the [Ollama model library](https://ollama.com/library) for the full list.

3. In Cockpit, create a new Agent tab and pick **Ollama** in the engine menu. **If the Ollama service isn't running, Cockpit auto-`spawn`s `ollama serve`** and waits up to 8 seconds for it to be ready.

4. Click the model dropdown in the tab header — Cockpit asks the Ollama API for the list of models you've pulled.

### What you get

- Any model you've pulled, picked per tab.
- Streaming replies.
- Tool use *(depends on the model — coding-tuned models support tool use, generic chat models often don't)*.
- Completely offline. No outbound network calls.
- Zero per-message cost.

### What you don't get

- **No image attachments.** Cockpit's Ollama tab is text-only for now, even if you pull a vision-capable model.
- **No "best practice" model picker.** Ollama gives you exactly what you pulled — Cockpit has no opinion. (There's a fallback default in code, but you should pick one yourself.) Start with a known-good coding model like `qwen3.5-coder` or `deepseek-coder` if you're unsure.

### Choosing a model

Rough sizing guidance — actual performance varies by GPU:

| Your hardware | Reasonable model sizes |
|---|---|
| MacBook Air (8 GB unified memory) | 1B – 3B models (very limited; quality will be low) |
| MacBook Pro M-series (16–32 GB) | 7B – 13B models (usable for everyday code Q&A) |
| Mac Studio / desktop with 64+ GB | 30B+ models (rivals smaller cloud models) |
| Workstation with discrete GPU 24 GB+ | 70B models (Claude-Haiku-class quality) |

For coding work specifically, look at `qwen3-coder`, `deepseek-coder`, and `codellama` families. They're more useful than a generic chat model of the same size.

### Common issues

- **"No models found" in the dropdown** — you haven't pulled anything yet. Open a terminal and run `ollama pull <name>` for at least one model.
- **Replies are extremely slow** — the model is bigger than your GPU can comfortably handle. Try a smaller one.
- **Auto-start didn't work** — run `ollama serve` in a terminal manually and try again.
