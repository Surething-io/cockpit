**Skills** are short prompts you trigger with `/` in any Agent tab — each one rewires how the AI works on a single reply. Cockpit ships **6 built-in Skills** (the `/qa /fx /ex /go /cg /cc` modes); you can also write your own as `SKILL.md` files and install them the same way. Both flavours live in the same `/` menu.

> Don't confuse these with the slash menu inside **Notes** (the project-notes editor), which is a formatter palette for headings, lists, tables and so on. The chat input only recognises Skills — typing `/` there opens a menu listing exactly `/qa /fx /ex /go /cg /cc` plus any installed `/skill-name`.

## The 6 built-in Skills

| Command | Intent | Asks back? | Writes code? |
|---|---|---|---|
| **`/qa`** | Requirement clarification | ✅ Yes | ❌ No |
| **`/fx`** | Bug evidence-chain analysis | ❌ | ❌ |
| **`/ex`** | Heavy structured discussion | ❌ | ❌ |
| **`/go`** | Execution / landing mode | ❌ | ✅ Yes, with self-verification |
| **`/cg`** | CodeGraph project exploration | ❌ | ❌ |
| **`/cc`** | End-to-end verification via `cock` CLI (browser + terminal bubbles) | ❌ | ❌ (drives bubbles, not source edits) |

## `/qa` — Clarify before changing anything

Use when you're about to ask for a code change but the request is still half-baked.

```text
/qa I want the docs sidebar to behave more like Cursor's
```

The AI will:

1. State what it thinks you want.
2. List the ambiguous parts.
3. Ask numbered questions, expecting your answers before touching any file.

It follows KISS and **never writes code in this mode**. The output is understanding + questions only. This is the right entry point for any non-trivial feature.

## `/fx` — Build a bug evidence chain

Use when you have a symptom and need to trace it to root cause.

```text
/fx the docs page renders ",[object Object]," in code blocks for some sessions
```

The AI will:

1. Form a hypothesis.
2. Inspect the code paths involved.
3. Lay out the evidence — what triggered what, line by line.
4. Propose minimal repro and root cause without suggesting a fix yet.

Pair with `/go` once you've agreed on the diagnosis.

## `/ex` — Deep structured discussion

Use when you want analysis without being interrupted by clarification questions. `/ex` is `/qa` minus the asking-back loop — it produces a long, structured discussion document.

```text
/ex compare three caching strategies for this endpoint
```

Good for design docs, RFCs, comparative analysis.

## `/go` — Land the change

Use when the plan is agreed and you want the AI to actually do the work.

```text
/go add a Redis cache to /api/heavy-endpoint with a 60s TTL
```

`/go` mode:

1. Splits the work into MVP-sized stages, each one self-contained and verifiable.
2. Writes code, runs the verification (typecheck, tests, hit the endpoint, etc.), emits a delivery summary + verification report.
3. **Advances to the next stage automatically** — no waiting for sign-off between stages.
4. Stops only for three reasons: a blocking ambiguity (missing API contract), a destructive operation (`git push --force`, drop table, …), or a branching decision the prior research didn't cover.
5. At the end, runs one end-to-end recap.

This is the mode you spend the most actual code-writing time in. Use after `/qa` or `/ex` has converged the plan.

## `/cg` — Explore the project as a graph

Use when you need to understand code structure without grepping everything.

```text
/cg what handlers call the database adapter?
```

`/cg` switches the AI to read Cockpit's local **CodeGraph** — a structural index of your project (who calls what, what calls whom, which files change together) — instead of brute-grepping every file. Answers come back faster and stay on-topic.

The graph builds itself the first time you ask. No setup, no project config. Works on TypeScript / JavaScript / Python / Go / Rust today.

## `/cc` — End-to-end verification via Cockpit CLI

Use when the code change is done and you want the AI to **actually run it**, click through the UI, watch network traffic, and confirm the behaviour really works.

```text
/cc terminal: cock terminal abc123
    browser:  cock browser xyz789
    verify the chat input "send" flow — message should land in the DB
    and the UI should refresh in real time
```

`/cc` switches the AI into a mode that **uses the Cockpit CLI** — `cock terminal <id> output` to read terminal output, `cock browser <id> click/type/network` to drive a Browser bubble, etc. You need to give it the **short IDs** (click the badge on the terminal / browser bubble's header) so it knows which bubbles to drive.

Typically chained after [`/go`](#go-land-the-change) — `/go` writes the code, `/cc` verifies it actually works in the rendered UI. Full walkthrough in [Quickstart](/en/docs/get-started/quickstart/#end-to-end-verification--console---cc).

## Pattern: chain modes

A typical end-to-end task chains modes:

```text
/qa we want to cache the heavy endpoint        ← clarify
/cg what handlers touch /api/heavy-endpoint?   ← discover code
/fx why is the endpoint slow?                  ← analyse
/go add a Redis cache with 60s TTL             ← execute
```

The right entry point depends on what you have:

- If you have a vague goal → `/qa`
- If you have a symptom → `/fx`
- If you have a question about the code → `/cg`
- If you want analysis without interruption → `/ex`
- If the plan is ready → `/go`

> The 6 built-in Skills above are the complete set Cockpit ships. For repeated workflows of your own, see [Custom Skills](#custom-skills) below — they show up in the same `/` menu as `/skill-name`.

## Custom Skills

Custom Skills are your own slash commands — the same idea as the 6 built-in modes above, except you write the prompt yourself. Trigger them as `/your-skill-name` in chat.

If you find yourself pasting the same long instruction to Claude every week — "review this PR for these specific things", "summarise commits in this format", "follow this debugging checklist" — turn it into a Skill once and reuse it forever.

### What a Skill is

A Skill is a single Markdown file named `SKILL.md`. The top of the file is a short YAML-style block that names the skill and describes it; the body is the prompt itself.

Minimal example:

```markdown
---
name: pr-review
description: Review a PR for our team's specific checklist
icon: 🔍
argument-hint: "[PR number or URL]"
---

You are reviewing a pull request for our team. Check for:

1. Tests covering the new behaviour
2. No breaking changes to public APIs
3. Migration notes in the changelog
4. Plain-English commit messages

Output a structured review with: Summary, Blockers, Suggestions, Approve/Reject.
```

That file can live anywhere on your computer — Cockpit doesn't move it.

| Field | Required? | What it does |
|---|---|---|
| `name` | Yes | The slash trigger. `/pr-review` here. Spaces become dashes. |
| `description` | Yes | The one-liner shown in the chat dropdown. |
| `icon` | Optional | An emoji shown beside the name in the dropdown. |
| `argument-hint` | Optional | A hint like `[PR number or URL]` shown in the dropdown so you remember what to type after the slash command. |

### Install a Skill in Cockpit

1. Open the **Skills** modal (from the sidebar or app menu).
2. Click **+ Add Skill**.
3. Paste the **absolute path to your SKILL.md file** (e.g. `/Users/me/skills/pr-review/SKILL.md`).
4. Press Enter.

Cockpit validates the file exists and reads the frontmatter. If something's wrong (file missing, malformed frontmatter), the skill card shows an `[Invalid]` badge.

To remove a skill, hover its card and click the trash icon.

> Cockpit doesn't copy the file — it just remembers the path. Move or rename the SKILL.md and the skill stops working until you delete and re-add it with the new path.

### Use a Skill

Once installed, just type `/` in any Agent tab. The chat dropdown shows two sections:

- **Commands** — the six built-in AI mode commands.
- **Skills** — everything you've installed, with their icons and argument hints.

Type to filter, then press Enter or Tab to insert. The chat input gets `/your-skill-name ` (with a trailing space, ready for arguments). Type any arguments you want, press Enter to send.

The AI receives your skill's prompt content followed by your arguments — **everything you type after the slash command** becomes the argument and is appended to the skill body. No special permissions, no separate menu — it's just a more polished way of pasting the same prompt every time.

### Sharing with your team

A Skill is one file. To share with a teammate, send them the SKILL.md (or push it to a shared repo). They add it the same way you did — paste the path, done.

Some teams keep a shared `~/team-skills/` directory with everyone's SKILL.md files in sub-folders, so adding a new skill is just `git pull` then **+ Add Skill** in Cockpit.

### Updates land instantly across tabs

When you add or remove a skill in one tab, every other open Cockpit tab updates its `/` menu immediately — no refresh required. Underneath it uses the browser's native `BroadcastChannel('cockpit-skills')` — pure client-side, zero-latency, no server round-trip.

## Next

- [CodeGraph (/cg)](/en/docs/explorer/search/#codegraph) — what the `/cg` API actually returns
- [Sessions](/en/docs/agent/sessions/) — how slash commands fit into the broader chat flow
