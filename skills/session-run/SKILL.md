---
name: session-run
description: "How to run an @<session Bot> line: send it into that existing session and bring its answer back (--no-wait: just send)."
hidden: true
---

# Running a `[session·@title]` line

A `[session·@title] <task>` line addresses one of the user's **session Bots** — sessions they marked
"can be @-mentioned" — by its title.
That session already exists, with its own project, engine and history. You are the messenger: send
the task into it and bring its answer back. Do not do the task yourself, and do not
start a new session for it — that is what `/dl` is for.

The session's `cwd` and `sessionId` are listed at the end of the message under "Sessions the
[session·@…] lines above address". Use them verbatim.

## 1. Write the message

The target session has its own context but none of THIS conversation. Send the user's request in
their own words, plus only what it cannot know from where it sits: the decisions or facts from this
conversation the request depends on. Keep it short — this is one more turn in a session that is
already up to speed on its own work, not a brief for a stranger.

**Wait for the answer by default** (§3) — addressing a session is how the user asks it something,
and a link alone makes them go and read it themselves. **`--no-wait` anywhere in the line is the
only exception**: send, restate the receipt, and stop (for a long job they will check on later).
Strip the flag from the message you send. A stray `--wait` (the older spelling) changes nothing
and is stripped the same way.

This is the opposite default to `/dl`, on purpose: `/dl` starts new work that runs on its own,
while an `@` line talks to a session that is already doing the work.

## 2. Send it — every line before waiting on any

```bash
MSG=$(mktemp /tmp/cockpit-msg.XXXXXX)
cat > "$MSG" <<'EOF_MSG'
<the message>
EOF_MSG

curl -sS --fail-with-body -X POST "{{BASE_URL}}/api/sessions/delegate" \
  -H "Content-Type: application/json" -H "x-cockpit-run-id: $COCKPIT_RUN_ID" \
  --data-binary @- <<EOF_JSON
{"cwd": "<cwd, verbatim>", "sessionId": "<sessionId, verbatim>", "title": "@<title>: <short label>", "briefPath": "$MSG"}
EOF_JSON
```

- Send **no** `engine` and **no** `model`: the session keeps its own, and the request is rejected
  if you set either.
- Keep the `x-cockpit-run-id` header: it is how the message is labelled with where it came from.
- Do not delete the message file — the session reads it after the POST returns.
- For a one-line task you may send `"prompt": "..."` instead of `briefPath` (escape `"` and `\`).
- The message is handled exactly as if the user had typed it into that session: if it is busy, the
  message joins its current run and is answered when it gets there; if it is idle, it starts a turn.
- The receipt comes back at once: `{ cwd, engine, sessionId, link, title, createdAt, existing: true,
  inputId, parent? }`. **Keep `inputId`**: it is how the wait follows THIS message rather than
  whatever the session last finished.
- A 400 names the problem (session not found, a session sending to itself). Report it as said; do
  not retry blindly and do not fall back to a new session.

## 3. Wait — unless the line said `--no-wait`

The moment the POST has returned, open `{{COCKPIT_DIR}}/skills/session-run/wait.md` and follow it
before any status call.

## 4. Reply — always restate the receipt

The receipt is the only record of what was sent. Repeat it:

```markdown
Sent to **@<title>** (<engine>, `<cwd>`) — [open session](<link>)
```

Unless the line said `--no-wait`, add its answer under that: a short summary of `lastReply` in a few lines, not the
whole thing pasted, and not restated as your own work. If the session was already busy when the
message arrived, its reply may also cover what it was doing before; say so when that is what the
reply reads like.

Pressing stop here does not stop the other session — it is a separate run.
