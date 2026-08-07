Cockpit talks to 6 AI engines out of the box. Each Agent tab picks one engine; you can mix and match across tabs without restarting — pick by what's running locally, what billing account you're on, or which model is best at the task in front of you.

| Engine | How to sign in | When to use |
|---|---|---|
| [Claude](#claude) | Anthropic `claude` CLI login | Default. Best general-purpose model. |
| [Codex](#codex) | `codex` CLI login | If you already have a Codex / GPT subscription. |
| [DeepSeek](#deepseek) | Paste API key in the per-tab DeepSeek picker | Strong reasoning at lower cost. |
| [GLM](#glm) | Paste API key in the per-tab GLM picker | Zhipu's models, on a mainland or an international host. |
| [Kimi](#kimi) | Paste API key in the per-tab Kimi picker | Long context, mostly used in China. |
| [Ollama](#ollama) | Nothing — runs locally | Offline use, sensitive data, custom models. |

> Everything runs locally.

## Overview

### At a glance

| Engine | How to sign in | When to use | Who you pay |
|---|---|---|---|
| **Claude** | Log in once via the `claude` CLI | Default. Best general-purpose model. | Anthropic |
| **Codex** | Log in once via the `codex` CLI | When you already have a Codex / GPT subscription. | OpenAI |
| **DeepSeek** | Paste an API key in the per-tab DeepSeek picker | Strong reasoning at lower cost. | DeepSeek |
| **GLM** | Paste an API key in the per-tab GLM picker | Zhipu's models, served from a mainland **or** an international host. | Zhipu / BigModel (pay-as-you-go or Coding Plan) |
| **Kimi** | Paste an API key in the per-tab Kimi picker | Long context, mostly used in China. | Moonshot (Kimi Code subscription) |
| **Ollama** | Nothing — it's local | Offline use, sensitive data, custom models. | Nobody (your own machine) |

### How engine selection works

Each Agent tab has an engine picker in its header. When you create a new tab, the engine defaults to **Claude**. Switching the engine for an existing tab starts a fresh session — Claude history doesn't carry over into a Codex tab, since each engine has its own conversation format.

You can have, say, six tabs open simultaneously:

- Tab 1: Claude on `~/code/backend`
- Tab 2: DeepSeek on the same project for a cheaper second opinion
- Tab 3: Codex on a different project
- Tab 4: Kimi on a notebook, using its long context window
- Tab 5: GLM on a script, billed to your BigModel Coding Plan
- Tab 6: Ollama running a local model for an offline draft

Cockpit's Session Browser (grid icon at the top of the sidebar) shows all of them.

### What each engine can do

|  | Claude | Codex | DeepSeek | GLM | Kimi | Ollama |
|---|---|---|---|---|---|---|
| Can read & edit your files | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ depends on model |
| Accepts image attachments | ✅ | ✅ | ✅ | ✅ (SDK mode only) | ✅ (SDK mode only) | ❌ |
| Streams replies as it thinks | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Runs offline | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Choose between model variants | Fixed (latest) | Fixed | flash / pro | Live list from GLM's API | Live list from your Kimi plan | Any model you've pulled |
| Shows running cost in the UI | ✅ | — | ✅ (estimated) | Quota, not cost — see [Check quota](#check-your-coding-plan-quota) | Quota, not cost — see [Check quota](#check-your-quota) | Free |

> Image support is engine-level. **Ollama** tabs **silently drop** image attachments (no error, but the AI doesn't see them). **GLM** and **Kimi** accept images in their default *Claude Agent SDK* mode; the **Built-in Agent** execution mode has no image support for any engine — see [Execution mode](#execution-mode-claude-agent-sdk-vs-built-in-agent).

### Setting up each engine

Per-engine sections below cover the specifics. Quick pointers:

- **Claude** — run `claude` once on your terminal and follow its login prompt. Cockpit reuses your Claude login automatically.
- **Codex** — install OpenAI's `codex` CLI and log in with it once. Cockpit reuses that login.
- **DeepSeek** — get a key from [platform.deepseek.com](https://platform.deepseek.com/), then **paste it in the DeepSeek picker in the Agent tab header** (not in the global Cockpit Settings). Pick a model variant in the same picker.
- **GLM** — get a key from the [BigModel console](https://bigmodel.cn/apikey/platform), then **paste it in the GLM picker in the Agent tab header**. Pick a model in the same picker, and check the **Region** row while you're there — see [Choose a region](#choose-a-region).
- **Kimi** — get a key from the [Kimi Code console](https://www.kimi.com/code/console), then **paste it in the Kimi picker in the Agent tab header**. Pick a model in the same picker.
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

### Switching models

Cockpit always uses Anthropic's current recommended Claude model. **There is no model picker** — you get the latest the service offers. Watch Anthropic's announcements to know which model is current; Cockpit picks it up automatically when the official SDK updates.

### Common issues

- **"Not logged in" / immediate error on first message** — run `claude` in a terminal and make sure the login completed. Cockpit can only use a login that already works for `claude` on its own.

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

DeepSeek is the cheapest cloud engine in Cockpit. Unlike Claude / Codex (which reuse a CLI's login), DeepSeek is API-key-only — paste a key in the per-tab DeepSeek picker and you're done. GLM and Kimi work the same way.

Under the hood it goes through DeepSeek's [Anthropic-compatible endpoint](https://api-docs.deepseek.com/en/guides/anthropic_api) routed via the Claude Agent SDK, so tool use, streaming, and context management all work like Claude.

### Setup

1. Get an API key from [platform.deepseek.com](https://platform.deepseek.com/). It looks like `sk-...`.

2. Open a new tab in Cockpit, pick **DeepSeek** in the engine menu, then **click the DeepSeek picker icon in the tab header** → paste the key into the **API Key** field → save. (The key lives in its own credential file, `~/.cockpit/deepseek/credentials.json` — *not* in `~/.cockpit/settings.json`, and not in the global Cockpit Settings modal. `settings.json` only remembers which model you picked.)

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

## GLM

GLM is Zhipu AI's model family, sold through the **BigModel** platform. Structurally it's the same kind of engine as [DeepSeek](#deepseek) and [Kimi](#kimi): API-key-only, with a live model picker, a quota readout, and a fork-able session store.

The one thing GLM has that no other engine does: it's served from **two hosts** — one in mainland China, one international — and the picker has a **Region** row to pick between them. Same key either way; see [Choose a region](#choose-a-region).

### Setup

1. Get an API key from the [BigModel console](https://bigmodel.cn/apikey/platform). GLM keys are two dot-separated halves, `<id>.<secret>` — no `sk-` prefix.

2. Open a new tab in Cockpit, pick **GLM** in the engine menu, then **click the model picker in the tab header** → paste the key into the **API Key** field → save. (The key lives in its own credential file, `~/.cockpit/glm/credentials.json` — *not* in `~/.cockpit/settings.json`, and not in the global Cockpit Settings modal.)

3. Pick a model in the same picker. Cockpit fetches the list from your account the moment the key is saved.

Done. The key only ever stays on your machine.

### Pick a model

The model list is **fetched live** from GLM's `GET /models` using your key — Cockpit hard-codes nothing, so new models show up on their own. At the time of writing the API returns eight:

`glm-4.5` · `glm-4.5-air` · `glm-4.6` · `glm-4.7` · `glm-5` · `glm-5-turbo` · `glm-5.1` · `glm-5.2`

A new GLM tab defaults to **`glm-5.2`**.

> **GLM publishes no per-model metadata.** Its model list is bare ids — no display name, no context window. So the picker shows ids only, and Cockpit sets no context-window hint for GLM tabs (Kimi tabs get one because Kimi reports it). That's a limit of the provider's API rather than a missing Cockpit feature; the Agent SDK falls back to its own default window.

> **`glm-5.2[1m]` is not supported.** BigModel's Claude Code docs mention that `[1m]` suffix for a 1M-token context. Cockpit can't offer it: the Anthropic-compatible endpoint rejects that id with HTTP 400 *"模型不存在"* — verified on two accounts, one of them on a Coding Plan. Use the bare `glm-5.2`.

### Choose a region

GLM is served from two hosts, and **the same key works on both**: a key issued on `bigmodel.cn` authenticates on `z.ai` and reports the identical quota. The region is pure routing.

| Region | Anthropic-compatible (SDK mode) | OpenAI-compatible (Built-in Agent mode) |
|---|---|---|
| **中国大陆** — mainland | `https://open.bigmodel.cn/api/anthropic` | `https://open.bigmodel.cn/api/coding/paas/v4` |
| **International** | `https://api.z.ai/api/anthropic` | `https://api.z.ai/api/coding/paas/v4` |

The default comes from your **Cockpit UI language**: English → International, everything else (including "auto") → mainland. Override it in the **Region** row of the GLM picker — your pick wins and is remembered.

Language only *seeds* that default; it never overrides a choice you made. That's deliberate: changing Cockpit's UI language shouldn't silently re-route your API traffic to a server in another country. If your language and your account don't line up, set the region once and forget it.

Sessions are **not** region-scoped. Switch regions whenever you like — existing GLM conversations stay resumable, and the key stays valid.

### Execution mode: SDK vs Built-in Agent

The GLM picker has an **Execution mode** toggle with two options, exactly like Kimi's. They talk to different GLM endpoints and keep **separate transcript stores**, so the mode is locked once a session has messages — to switch, open a new tab.

| | **Claude Agent SDK** (default) | **Built-in Agent** |
|---|---|---|
| What runs the loop | The official Claude Agent SDK, pointed at GLM | Cockpit's own agent loop |
| Endpoint | The region's Anthropic-compatible host | The region's OpenAI-compatible host |
| Image attachments | ✅ | ❌ (no engine supports images in this mode) |
| Sessions on disk | `~/.cockpit/glm/projects/<project>/<session>.jsonl` | `~/.cockpit/glm-sessions/<project>/<session>.jsonl` |

Stay on **Claude Agent SDK** unless you have a reason not to — it's the mode that gets images, subagents, and everything else the SDK brings.

### Check your Coding Plan quota

GLM's **Coding Plan** is a subscription, so the GLM tab gets a **Check quota** button next to the model picker rather than a dollar total. Click it and Cockpit reads what's left in two windows:

- a rolling **5-hour** window, and
- a **weekly** one.

Each shows as `remaining/limit`, prefixed by your plan tier — e.g. `lite · 5h 1990/2000 · 1w 4980/5000`. Hover for when the longer window resets; it goes red when a window is exhausted. The button needs a saved key and doesn't poll — it fetches only when you click.

> **No Coding Plan means no quota, and that's normal.** A plain pay-as-you-go BigModel key has no plan allowance to report, so the button answers *"Quota unavailable — check the API key"*. Chatting still works exactly as before — you're just billed per token instead. The link next to the button opens [BigModel's usage page](https://bigmodel.cn/coding-plan/personal/usage) for the real figures.

### What you get

- **A model picker**, live from GLM's API (see above).
- **A region switch** — mainland or international, same key, sessions unaffected.
- **Image attachments** in Claude Agent SDK mode — paste images (`Cmd+V`) and GLM can see them. PNG / JPEG / WEBP / GIF.
- Streaming replies.
- Tool use — GLM can read your files, run shell commands, edit code.
- **Forking** — fork a GLM session from any message, same as Claude.
- Per-tool-call [snapshots](/en/docs/agent/snapshots/), like every other engine.
- Multi-tab sessions, each independent.

### What you don't get

- **No dollar cost readout you should trust.** Any USD figure in the token bar comes from the Agent SDK's own price table, not from GLM. On a Coding Plan use **Check quota**; on pay-as-you-go check the BigModel console.
- **No context window or display name in the picker** — GLM doesn't report either. See the note under [Pick a model](#pick-a-model).
- **No `[1m]` long-context variant.** `glm-5.2[1m]` is rejected by the endpoint Cockpit uses.
- **No images in Built-in Agent mode.** An images-only message is rejected with *"The built-in agent requires a text prompt"*; a message with text *and* images is answered, with the images dropped.

### Common issues

- **The picker says "Set API key"** — no key saved yet. It goes in the **GLM picker in the tab header**, not the global Cockpit Settings modal.
- **"Failed to load models — check the API key"** / **401** — bad or expired key. Re-paste it from the [BigModel console](https://bigmodel.cn/apikey/platform) and watch for stray whitespace; a GLM key is the full `<id>.<secret>` string, both halves included.
- **HTTP 400 "模型不存在"** — that model id isn't served to your account. Most often it's the `[1m]` suffix, which Cockpit can't use at all; pick a plain id from the list.
- **Quota says unavailable but chat works** — your account has no Coding Plan. Nothing is broken; see [Check your Coding Plan quota](#check-your-coding-plan-quota).
- **Slow or flaky connection** — you may be on the far host. Flip the **Region** row: mainland accounts are usually fastest on `open.bigmodel.cn`, and the same key works on `api.z.ai` if you're outside China. Switching is safe; sessions survive it.
- **Pasted images are ignored** — the tab is in **Built-in Agent** mode. Open a new tab on **Claude Agent SDK** mode (the mode can't be changed once a session has messages).

## Kimi

Kimi is a Chinese-market AI from Moonshot, known for long context windows. Cockpit talks to **Kimi Code** directly over its API — paste a key in the per-tab Kimi picker and you're done. Structurally it's the same kind of engine as [DeepSeek](#deepseek): API-key-only, with a model picker and a fork-able session store.

> **Changed:** Cockpit no longer uses Moonshot's `kimi` CLI. You don't need it installed, and its login no longer matters. See [Upgrading from the `kimi` CLI](#upgrading-from-the-kimi-cli) if you used Kimi in an earlier Cockpit.

### Setup

1. Get an API key from the [Kimi Code console](https://www.kimi.com/code/console). It looks like `sk-kimi-...`.

   > This is a **Kimi Code** key, not a Kimi Open Platform key from `platform.moonshot.cn`. The two are separate products and the keys are **not** interchangeable — an Open Platform key will fail here.

2. Open a new tab in Cockpit, pick **Kimi** in the engine menu, then **click the model picker in the tab header** → paste the key into the **API Key** field → save. (The key lives in its own credential file, `~/.cockpit/kimi/credentials.json` — *not* in `~/.cockpit/settings.json`, and not in the global Cockpit Settings modal.)

3. Pick a model in the same picker. Cockpit fetches the list from your account the moment the key is saved.

Done. The key only ever stays on your machine.

### Pick a model

The model list is **fetched live** from Kimi's `GET /coding/v1/models` using your key — it isn't a list Cockpit hard-codes. Which models come back depends on your **membership tier**, so two accounts can see different lists, and the list changes when Kimi ships or retires a model.

At the time of writing a Kimi Code account can see:

| Model | Context | Notes |
|---|---|---|
| **`kimi-for-coding`** (K2.7 Coding) | 256K | The default pick. |
| **`kimi-for-coding-highspeed`** | 256K | Same model, faster serving. Needs an **Allegretto** or higher membership. |
| **`k3`** (K3) | 1M | Long-context flagship. Needs **Moderato** or higher. |
| **`k3-256k`** | 256K | K3 at a smaller window. Needs **Moderato** or higher. |

> Don't treat that table as fixed — if a model isn't in your picker, your plan doesn't include it. The picker shows the model id, its display name when it differs, and its context window.

### Execution mode: Claude Agent SDK vs Built-in Agent

The Kimi picker has an **Execution mode** toggle with two options. They talk to different Kimi endpoints and keep **separate transcript stores**, so the mode is locked once a session has messages — to switch, open a new tab.

| | **Claude Agent SDK** (default) | **Built-in Agent** |
|---|---|---|
| What runs the loop | The official Claude Agent SDK, pointed at Kimi | Cockpit's own agent loop |
| Endpoint | `https://api.kimi.com/coding/` (Anthropic-compatible) | `https://api.kimi.com/coding/v1` (OpenAI-compatible) |
| Image attachments | ✅ | ❌ (no engine supports images in this mode) |
| Sessions on disk | `~/.cockpit/kimi/projects/<project>/<session>.jsonl` | `~/.cockpit/kimi-sessions/<project>/<session>.jsonl` |

Stay on **Claude Agent SDK** unless you have a reason not to — it's the mode that gets images, subagents, and everything else the SDK brings.

### Check your quota

Kimi Code is a **subscription**, not a prepaid balance, so the Kimi tab has a **Check quota** button next to the model picker instead of a cost readout. Click it and Cockpit reads what's left in:

- your **plan cycle** — a 7-day window, and
- a rolling **5-hour window** on top of it.

Both show as `remaining/limit` (e.g. `plan 100/100 · 5h 40/50`); hover for when the plan window resets. It goes red when a window is exhausted. The button needs a saved key and doesn't poll — it only fetches when you click.

### What you get

- **A model picker**, live from your account (see above).
- **Image attachments** in Claude Agent SDK mode — paste images (`Cmd+V`) and Kimi can see them. PNG / JPEG / WEBP / GIF.
- Streaming replies, with **the model's "thinking" steps folded into a `<details>` block before the final answer**.
- Tool use — Kimi can read your files, run shell commands, edit code.
- **Forking** — fork a Kimi session from any message, same as Claude. (This didn't work when Kimi went through the CLI.)
- Per-tool-call [snapshots](/en/docs/agent/snapshots/), like every other engine.
- Multi-tab sessions, each independent.

### What you don't get

- **No dollar cost readout.** Kimi Code bills by subscription, so there's nothing per-token to total up — use **Check quota** instead. Any USD figure the token bar shows comes from the SDK's own price table, not from Kimi.
- **No images in Built-in Agent mode.** An images-only message is rejected with *"The built-in agent requires a text prompt"*; a message with text *and* images is answered, with the images dropped.

### Upgrading from the `kimi` CLI

If you used Kimi in an earlier Cockpit, two things changed and both are breaking:

- **Your `kimi` CLI login no longer applies.** Get a [Kimi Code key](https://www.kimi.com/code/console) and paste it into the picker. The CLI itself is no longer used or required — you can uninstall it as far as Cockpit is concerned.
- **Old Kimi transcripts are gone from Cockpit.** Sessions used to live in `~/.kimi`; Cockpit no longer indexes that directory, so those conversations won't appear in the sidebar or the Session Browser. **The files are untouched on disk** — `~/.kimi` is still there if you want to read or archive it yourself. New sessions land under `~/.cockpit/kimi/`.

### Common issues

- **The picker says "Set API key"** — no key saved yet. It goes in the **Kimi picker in the tab header**, not the global Cockpit Settings modal.
- **"Failed to load models — check the API key"** / **401** — bad, expired, or wrong-product key. Re-paste it (watch for stray whitespace) and confirm it's a `sk-kimi-...` key from the Kimi Code console rather than a `platform.moonshot.cn` one.
- **A model you expected isn't listed** — the list is gated by membership tier. `k3` needs Moderato or higher, `kimi-for-coding-highspeed` needs Allegretto or higher.
- **Replies stop mid-day** — you may have hit the 5-hour window. Click **Check quota**; if it's red, wait for the reset shown in the tooltip.
- **Pasted images are ignored** — the tab is in **Built-in Agent** mode. Open a new tab on **Claude Agent SDK** mode (the mode can't be changed once a session has messages).

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
