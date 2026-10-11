---
name: dl
description: "Delegate a sub-task to a new Cockpit session in any project on any engine; returns at once, or waits for the result with --wait."
argument-hint: "[--wait] <what to delegate, and optionally which engine / project>"
---

Hand a sub-task to a brand-new session that runs on its own — in another project directory and/or on another engine (codex, deepseek, kimi, glm, ollama, claude). By default you do NOT wait for it: you get a receipt back at once, and the child notifies the user when it finishes.

**`--wait`** — when the arguments contain `--wait`, wait for the child to finish and carry on with its result in this same turn. Strip `--wait` from the task itself. Only the flag decides this: without it, never wait, even when later steps look like they depend on the result — delegate, restate the receipt, and say the result can be checked later.

Use it when the work belongs in another directory, suits another engine, or simply should not block this conversation. For parallel work inside this same repository, your own subagents are usually the better tool.

## 1. Delegate

Decide: target `cwd` (absolute project directory), `engine`, a short `title`, and the task. Write the task as a self-contained brief — the child sees none of this conversation. Put anything longer than a line or two in a brief file, so no JSON escaping is involved:

```bash
BRIEF=$(mktemp /tmp/cockpit-brief.XXXXXX)
cat > "$BRIEF" <<'EOF_BRIEF'
<goal, context the child needs, constraints, what "done" looks like>
EOF_BRIEF

curl -sS --fail-with-body -X POST "{{BASE_URL}}/api/sessions/delegate" \
  -H "Content-Type: application/json" \
  -H "x-cockpit-run-id: $COCKPIT_RUN_ID" \
  --data-binary @- <<EOF_JSON
{"cwd": "/abs/target/project", "engine": "codex", "title": "<short label>", "briefPath": "$BRIEF"}
EOF_JSON
```

- `engine` is inherited from the session you are running in when omitted — that is what the
  `x-cockpit-run-id` header above is for, so always send it. Spell `engine` out only when the
  task should run somewhere else, which for `/dl` it often should. Claude when the calling
  session's engine cannot be determined. `model` is optional and never inherited
- For a one-liner you may send `"prompt": "..."` instead of `briefPath` (escape `"` and `\`)
- Do not delete the brief file — the child reads it after you return
- A 400 names the problem (missing directory, unconfigured engine, too many delegated sessions running) — report it, do not retry blindly

The receipt: `{ cwd, engine, model?, sessionId, link, title, createdAt, parent? }`.

## 1b. Wait — only with `--wait`

The moment the POST has returned a receipt, open `{{COCKPIT_DIR}}/skills/dl/wait.md` and follow it before any status call. It holds the poll loop and the budget rule that keep the wait alive past your Bash timeout. Skip it and you will either block past the timeout and lose the result, or report an outcome the child never produced.

## 2. Reply — always restate the receipt

The receipt is the ONLY record of this delegation. Tool output is not searchable later, so repeat it in your reply text:

```markdown
Delegated **<title>** to <engine> in `<cwd>` — [open session](<link>)
```

Use the `link` exactly as returned.

With `--wait`, add the outcome right under it — the `status` and a summary of `lastReply` — then continue with the rest of the turn using that result.

## 3. When the user asks how it went

1. Find the receipt: first in this conversation; otherwise search past sessions with the `/ss` flow (query the title or topic — your earlier reply and the child session itself are both indexed)
2. Check it:

```bash
curl -sS --fail-with-body --get "{{BASE_URL}}/api/sessions/status" \
  --data-urlencode "cwd=<cwd>" --data-urlencode "sessionId=<sessionId>"
```

3. Report `status` — `running`, `done` (the last turn finished normally), `failed` (the engine recorded an error) or `incomplete` (stopped, interrupted or never finished; the user can open it and continue) — summarize `lastReply`, and give the `link`.
   `lastReply` is cut to 4000 characters; when `lastReplyTruncated` is true and you need all of it, repeat the call with `--data-urlencode "full=1"`.
