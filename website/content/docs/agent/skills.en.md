**Skills** are short prompts you trigger with `/` in any Agent tab — each one rewires how the AI works on a single reply. OpenCockpit ships **16 visible built-in Skills** (the `/qa /spec /design /pair /fx /ex /go /cg /cc /cr` modes, plus `/html /new-branch /skillify /ss /dl /bot`); you can also write your own as `SKILL.md` files and install them the same way. Both flavours live in the same `/` menu.

> Don't confuse these with the slash menu inside **Notes** (the project-notes editor), which is a formatter palette for headings, lists, tables and so on. The chat input only recognises Skills — typing `/` there opens a menu listing the built-ins plus any installed `/skill-name`.

## The built-in Skills

| Command | Intent | Asks back? | Writes code? |
|---|---|---|---|
| **`/qa`** | Lean PRD: goals, scope, assumptions, and decisions | For open decisions | ❌ No |
| **`/spec`** | Implementation-ready specification | ✅ For material decisions | ❌ No |
| **`/design`** | Code-grounded technical design and implementation plan | For material decisions | ❌ No |
| **`/pair`** | Programming partner for code and design judgement | If material ambiguity remains | When explicitly asked to modify |
| **`/fx`** | Root-cause evidence, fix options, and verification | For fix decisions | ❌ |
| **`/ex`** | Evidence-backed deep analysis | ❌ | ❌ |
| **`/go`** | Implement agreed work, verify slices, and log decisions | For blockers or costly choices | ✅ Yes |
| **`/cg`** | CodeGraph project exploration | ❌ | ❌ |
| **`/cc`** | Cockpit CLI: browsers, terminal observation, codegraph | If the target remains unclear | ❌ (operates the CLI) |
| **`/cr`** | Full code review (static + dynamic) | ❌ | ❌ (produces findings, no edits) |
| **`/html`** | Build an interactive local React app wired to the [bash SDK](/en/docs/agent/html-apps/) | Confirms the app and directory first | ✅ Yes |
| **`/new-branch`** | Cut and verify a clean branch from the latest `origin/main` | If naming or working-tree state needs a choice | ❌ (git only) |
| **`/skillify`** | Assess and distil a proven workflow into a reusable Skill | For the save directory if missing | ✅ If worth extracting |
| **`/ss`** | Find a past session — any project, engine or date — from one sentence | ❌ | ❌ (search only) |
| **`/dl`** | Delegate to a new session; return immediately or wait with `--wait` | If required task details are missing | The child performs the task |
| **`/bot`** | Create and register a Bot with long-term context | Confirms role, name, and directory first | Writes Bot files |

The first ten are *modes* — they change how the AI works for one reply — and each gets a section below. The remaining six are task commands; their SKILL.md carries the full instructions, so there is nothing to configure. `/ss` and `/dl` also get short sections below, since they work across sessions.

## `/qa` — Clarify before changing anything

Use when you're about to ask for a code change but the request is still half-baked.

```text
/qa I want the docs sidebar to behave more like Cursor's
```

The AI will:

1. Produce a lean PRD covering the problem, goal, success criteria, scope, constraints, and assumptions.
2. Present unresolved decisions with numbered options, tradeoffs, and a recommendation.
3. On answers, return only changed requirements and remaining open decisions.

This mode clarifies what and why; it does not design the solution or write code. Use `/spec` when the requirements need implementation-ready detail.

## `/spec` — Specify agreed requirements

Use when the intent is agreed and development needs explicit behavior, contracts, boundaries, and acceptance criteria. A `/qa` brief, a document, or the current conversation can supply the input; `/qa` is optional.

```text
/spec Turn the agreed sidebar requirements into a specification
```

The AI checks relevant integration assumptions, links acceptance scenarios to behavior rules, and asks only about unresolved material decisions. It does not implement the feature. Output stays in the conversation unless you request a saved document; answering decisions does not authorize implementation.

## `/design` — Design the implementation

Use when the expected behavior is clear but the technical approach and execution steps need to be established. Input can be a SPEC, agreed requirements, or the current conversation; `/qa` and `/spec` are optional.

```text
/design Design the implementation of the agreed sidebar specification
```

The AI traces relevant code and contracts, explains responsibilities and material tradeoffs, and produces ordered implementation steps with completion checks and acceptance-linked verification. Technical unknowns are investigated where possible or recorded as prerequisites. Existing SPEC decisions are reused, not reopened; the output scales to the change.

This mode does not implement the feature. Output stays in the conversation unless you request a saved document; answering decisions does not authorize implementation.

## `/pair` — Think through code together

Use whenever you want to discuss an approach, inspect an implementation, trace a bug, or understand tangled structure. The current conversation supplies the target and constraints; there is no required preceding mode or document.

```text
/pair Take a look at whether this session-state model is appropriate
/pair Apply the second approach we just discussed and verify it
```

A request to take a look produces evidence-based advice. An explicit request to implement, fix, clean up, or apply advice produces changes and verification within that scope; restrictions such as "only look, do not change anything" remain in force. An advice invocation does not cancel other active tasks.

The AI traces actual behavior, responsibilities, and boundaries, checks that necessary guarantees remain covered before recommending a replacement, and reports its judgement, key evidence and tradeoffs, and next steps or verification. It does not require a formal design document or code-review report.

## `/fx` — Build a bug evidence chain

Use when you have a symptom and need to trace it to root cause.

```text
/fx the docs page renders ",[object Object]," in code blocks for some sessions
```

The AI will:

1. Form a hypothesis.
2. Inspect the code paths involved.
3. Lay out the evidence — what triggered what, line by line.
4. Identify the root cause and blast radius, compare fix options, and describe how to verify a fix. Unverified links stay explicitly labelled as hypotheses; this mode makes no code changes.

Pair with `/go` once you've agreed on the diagnosis.

## `/ex` — Deep analysis, answer first

Use when a complex question needs an evidence-backed conclusion without clarification pauses. The AI gives the answer first, then cited findings, adding options, risks, and pending points where relevant. It marks missing information and its impact, keeps analyzing, and makes no code changes.

```text
/ex compare three caching strategies for this endpoint
```

Good for complex questions, comparing approaches, and explaining how something works. Simple questions get a direct answer; follow-ups return only what changed.

## `/go` — Land the change

Use when the plan is agreed and you want the AI to actually do the work.

```text
/go add a Redis cache to /api/heavy-endpoint with a 60s TTL
```

`/go` mode:

1. Takes a supplied spec or brief, or the agreement in the conversation; asks once if success criteria cannot be inferred.
2. Implements small slices and verifies each by running commands, requests, or tests.
3. Retries failed verification at most three times, then marks the slice blocked and continues independent work.
4. Records reversible choices the spec did not cover; asks about costly choices, destructive operations, or information that blocks progress. Finished slices need no sign-off.
5. Runs the full user flow and reports its result, the decision-notes link, and residual work. Notes live outside the repository and expire after 30 days untouched.

This is the mode you spend the most actual code-writing time in. Use after requirements or analysis have converged, with `/spec` when explicit behavior and acceptance rules are needed.

## `/cg` — Explore the project as a graph

Use when you need to understand code structure without grepping everything.

```text
/cg what handlers call the database adapter?
```

`/cg` switches the AI to read Cockpit's local **CodeGraph** — a structural index of your project (who calls what, what calls whom, which files change together) — instead of brute-grepping every file. Answers come back faster and stay on-topic.

The graph builds itself the first time you ask. No setup, no project config. Works on TypeScript / JavaScript / Python / Go / Rust today.

## `/cc` — Operate Cockpit through the CLI

Use when the code change is done and you want the AI to **actually run it**, click through the UI, watch network traffic, and confirm the behaviour really works.

```text
/cc terminal: cockpit terminal abc123
    browser:  cockpit browser xyz789
    verify the chat input "send" flow — message should land in the DB
    and the UI should refresh in real time
```

`/cc` switches the AI into a mode that **uses the Cockpit CLI** — `cockpit terminal <id> output` to read terminal output, `cockpit browser <id> click/type/network` to drive a Browser bubble, etc. Give **short IDs** when available. Otherwise the AI lists project bubbles and matches their titles or URLs; it can open a browser bubble itself and closes those it creates when done. Terminal observation is read-only. It defaults to `cockpit` (production); use `/cc dev …` or explicitly name `cockpit-dev` for development.

Typically chained after [`/go`](#go-land-the-change) — `/go` writes the code, `/cc` verifies it actually works in the rendered UI. Full walkthrough in [Quickstart](/en/docs/get-started/quickstart/#end-to-end-verification--console---cc).

## `/cr` — Full code review (static + dynamic)

Use when a PR is done and you want one complete review pass — both static correctness and the dynamic behaviour (timing / state / concurrency) you can't catch line-by-line.

```text
/cr review the current branch against main
```

`/cr` splits the review into two tracks: **static triangulation** (cross-locate each change against three references — intent / input domain / surrounding contracts) sweeps every change; slices touching state / timing / concurrency additionally run **dynamic derivation** (draw a state diagram + timeline, evaluate 6 classes of dynamic risk). The actual review runs in clean subagents while the main session only dispatches and merges, ending with a verdict, a solution diagram, severity-ranked findings, and a coverage report.

It's a self-contained methodology with no external tooling; tiny changes use one reviewer, while the default separates static and dynamic review. Dynamic modeling depends on the surfaces touched; `hard` explicitly requests one reviewer per dynamic slice. Typically paired with [`/go`](#go-land-the-change) — `/go` lands the change, `/cr` does the quality pass.

## `/ss` — Find a past session

Use when you remember what a conversation was about, but not which project, engine or day it happened in.

```text
/ss the session where we discussed CSRF on the local API
```

The AI doesn't search your sentence verbatim. It expands it into a few keywords (both languages for technical topics, plus synonyms), searches every session Cockpit can read — all projects, all engines (Claude, Codex, DeepSeek, Kimi, GLM, Ollama), all dates — reads the matching snippets, and replies with 1–3 candidates. Each candidate carries a session link: click it and Cockpit switches to that project and opens the session in the Agent panel.

Under the hood Cockpit keeps a text-only copy of each session's prompts and replies — no tool output, system reminders or images — under `<data-dir>/search-corpus`, updated incrementally, and searches it with ripgrep, so short Chinese words like `快照` match too. Subagent transcripts are not included. The first search on a machine can take a few seconds while that copy is built. Endpoint: `GET /api/sessions/search`.

## `/dl` — Delegate, optionally wait

Use when a piece of work belongs in another directory, suits another engine, or simply shouldn't block the conversation you're in.

```text
/dl have codex fix the flaky date test in the api project
```

The AI writes a self-contained brief (the child sees none of your conversation), starts a brand-new session in the target directory on the chosen engine, and gets a receipt back at once — engine, directory, session id, link. It repeats the receipt in its reply and carries on. The child runs on its own like any other session; open the link any time to watch it or take over.

Add `--wait` to wait for the child and continue with its result in the same turn. Without the flag, the command returns immediately.

Later, ask "how did that delegated task go?". The AI finds the receipt — in this conversation, or through the `/ss` flow — and checks the child: `running`, `done`, `failed`, or `incomplete` (stopped or interrupted; open it and continue), plus its last reply.

- **Nothing is stored server-side.** The receipt in the parent conversation is the record; status is read from the child engine's own transcript.
- **Engines:** `claude`, `codex`, `deepseek`, `kimi`, `glm`, `ollama`. Left unspecified, a delegated session runs on the same engine as the session that started it (falling back to `claude` when that cannot be determined). The target engine must already be configured; errors like a missing directory come back immediately.
- **Concurrency cap:** at most 4 delegated sessions run at once by default (`COCKPIT_DELEGATE_MAX`, see the [CLI reference](/en/docs/reference/cli/#environment-variables)). Past the cap the request is rejected, not queued.
- **Not a subagent replacement.** For parallel work inside the same repository, Claude's own subagents are usually the better tool. `/dl` is for other directories, other engines, and sessions you can open and take over.

Endpoints: `POST /api/sessions/delegate`, `GET /api/sessions/status`.

## Pattern: chain modes

For a feature, use `/qa` → `/spec` → `/design` → `/go` as needed; simple changes can skip stages that add no useful information. Use `/pair` at any point for code and design judgement; it is not a required stage in this sequence.

A typical investigation task chains modes:

```text
/qa we want to cache the heavy endpoint        ← clarify
/cg what handlers touch /api/heavy-endpoint?   ← discover code
/fx why is the endpoint slow?                  ← analyse
/go add a Redis cache with 60s TTL             ← execute
/cr review this change                         ← review
```

The right entry point depends on what you have:

- If you have a vague goal → `/qa`
- If you have a symptom → `/fx`
- If you have a question about the code → `/cg`
- If you want analysis without interruption → `/ex`
- If requirements need behavior, contracts, and acceptance criteria → `/spec`
- If behavior is clear but the technical approach and steps need design → `/design`
- If you want to discuss an approach or inspect code together → `/pair`
- If the plan is ready → `/go`
- If a change is done and needs review → `/cr`
- If you need an earlier conversation back → `/ss`
- If the work belongs in another project or on another engine → `/dl`

> The table above lists the visible built-in Skills. Internal `bot-run` and `bot-turn` workflows are hidden from the `/` menu. For repeated workflows of your own, see [Custom Skills](#custom-skills) below — they show up in the same `/` menu as `/skill-name`.

## Custom Skills

Custom Skills are your own slash commands — the same idea as the built-in modes above, except you write the prompt yourself. Trigger them as `/your-skill-name` in chat.

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

- **Commands** — visible built-in commands.
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
