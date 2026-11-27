# Waiting for a session Bot's answer (`@<title> <task>`)

Opened from `session-run` the moment the POST has returned a receipt, unless the line carried
`--no-wait`. The goal: get that session's status and last reply back into THIS turn.

The target may take longer than one bash call's tool timeout, so the wait has to survive that.
Two ways, in order of preference:

**Run it in the background if your Bash tool can** (`run_in_background`, a job that notifies you
on exit, or equivalent). Set `BUDGET` high (3600) and launch once.

**Otherwise wait in chunks.** Foreground, `BUDGET` about 10% under your Bash timeout (600s max →
`BUDGET=540`; can't raise it → assume 120s and use `BUDGET=100`). Each call prints where things
stand and exits; if the session is still running, run the same block again. That is the normal
path, not a failure.

```bash
CWD='<the receipt's cwd, verbatim>'
SID='<the receipt's sessionId>'
INPUT='<the receipt's inputId>'
BUDGET=540                       # seconds THIS call may spend

started=$(date +%s)
deadline=$(( started + BUDGET ))
while :; do
  body=$(curl -sS --fail-with-body --get "{{BASE_URL}}/api/sessions/status" \
    --data-urlencode "cwd=$CWD" --data-urlencode "sessionId=$SID" --data-urlencode "inputId=$INPUT") || body='{}'
  state=$(printf '%s' "$body" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("status","?"))
except Exception: print("?")')
  echo "+$(( $(date +%s) - started ))s $SID -> $state"
  # `?` = the status call failed, NOT a terminal state: keep waiting so a blip
  # retries and a real mistake shows up as a stall, never as "finished".
  if [ "$state" != running ] && [ "$state" != '?' ]; then
    printf '%s\n' "$body"
    break
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then echo "still running: $SID"; break; fi
  if [ "$(( $(date +%s) - started ))" -lt 30 ]; then sleep 5; else sleep 15; fi
done
```

- **`still running: <sid>`** → the budget ran out first. Run the same block again.
- **Otherwise** the last line is the full status report: `status`, `lastReply`,
  `lastReplyTruncated`, `link`. With `inputId`, `lastReply` is the answer to YOUR message, and
  `incomplete` with "not delivered" means the session stopped before taking it in — say so; do
  not present an older answer. When `lastReplyTruncated` is true and you need all of it, call the
  status endpoint once more with the same parameters plus `--data-urlencode "full=1"`.
- **Repeated `-> ?` lines** → the call is wrong (wrong `cwd`, wrong id, server gone), not the
  session. Re-run the bare curl without `|| body='{}'`, read the error body, and fix it. Never
  report `?` as an outcome.

The POST only returns once the message is in that session's run, so the first status you see is
`running` — a `done` on the very first poll is not a stale answer from before your message.

**There is no fixed cap.** Once it has run past roughly half an hour, stop waiting silently — say
it is still going, hand over the link, and let the user decide.

**Never state an outcome you have not seen a non-`running` status for.**

`done` = the turn finished normally; `failed` = the engine recorded an error; `incomplete` =
stopped or interrupted, and the user can open it and carry on.

Terminal status reached → go back to `session-run` §4 and reply with the receipt plus the answer,
then continue whatever this turn was doing with it in hand.
