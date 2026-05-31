Scheduled tasks let Cockpit run an AI prompt for you on a schedule — once after a delay, every N minutes, or on a cron expression. Use them for the things you'd otherwise have to remember to do every morning, every hour, or every Friday afternoon.

## Open the panel

There's a **Scheduled Tasks** panel in the sidebar (clock icon). It lists every task you've set up, with controls to add, edit, pause / resume, run-now, delete, and drag-reorder.

## Three kinds of schedule

When you create a task, pick one of three schedule types:

| Type | When it runs | Field you fill in |
|---|---|---|
| **Once** | After a delay, one time only | `delayMinutes` — how many minutes from now |
| **Interval** | Every N minutes, repeatedly | `intervalMinutes` — how often. Optional `activeFrom` / `activeTo` **time-of-day window** (`HH:MM` format; cross-midnight ranges like `22:00–06:00` work) |
| **Cron** | Standard cron expression | **5-field** (min hour dom month dow), e.g. `0 9 * * *` (every day at 9 AM). No seconds field. |

Each row in the panel shows a **countdown to the next fire** (e.g. `next: in 23m`), updating live.

## What you fill in

A scheduled task carries:

- **Project** — which project's working directory it runs in.
- **Engine** — Claude / Codex / DeepSeek / Kimi / Ollama.
- **Prompt** — what message to send. Can be a single line, can be multi-line.
- **Schedule** — one of the three types above.

A typical morning task:

```
Project: ~/code/my-service
Engine:  Claude
Schedule: cron, weekdays at 9 AM  (0 9 * * 1-5)
Prompt: Summarise yesterday's merged PRs in this repo: title, author,
        files touched, one-line "why it matters". Group by feature area.
```

## Same session accumulates

**Each scheduled task is bound to one sessionId** — every fire `resume`s that session instead of opening a new conversation. Consequences:

- Repeated fires **accumulate in the same chat**; later fires can see what earlier ones said. The AI has memory like "I already reported yesterday's PRs."
- Ideal for "long-running follow-up on the same thing" (daily digests, weekly sweeps, monitoring).
- Want a clean slate each time? **Delete the task and recreate it** — that gets a fresh sessionId.

## After a task runs

Each task displays its **last run status** (✓ success / ✗ error) and a small **red dot** if you haven't read the result yet. Click the task to open the session it ran in — that's where the AI's reply lives. The red dot clears.

Scheduled tasks also fire the [session-completion toast](/en/docs/agent/sessions/#session-completion-toasts) the same way manual sessions do.

## Manual controls

| Button | What it does |
|---|---|
| **✏ Edit** | Change prompt / schedule / engine etc. |
| **▶ Run now** | Trigger the task immediately without waiting for the schedule (still resumes the same sessionId). |
| **⏸ Pause / ▶ Resume** | Toggle; while paused no scheduled fires happen; on resume the next fire time is recomputed from now. |
| **✕ Delete** | Remove the task (also how you get a clean session next time). |
| **Drag handle** | Reorder tasks in the panel. |

## Cockpit has to be running

Scheduled tasks fire from a daemon inside Cockpit's server, **not from your browser**. So:

- ✅ Browser tab closed → tasks still fire (the server is running).
- ✅ Computer asleep → on wake, tasks resume at the next scheduled point (**no catch-up** for missed runs).
- ❌ Cockpit server stopped → no fires. Start `cockpit` again and they resume on their normal schedule (task definitions persist; in-memory timers are rebuilt from the next-fire time).

If you want tasks to survive across reboots, make sure Cockpit is running. The simplest way is to start it in a terminal at the start of your work day and leave it.

## What scheduled tasks are good for

A few patterns that actually work in practice:

- **Daily PR digest** — cron at 9 AM, prompt the AI to summarise yesterday's merged PRs.
- **Stale issue sweep** — cron once a week, list open issues with no activity for 30+ days.
- **Build health check** — interval every 2 hours, run `npm test` and report.
- **Release notes draft** — a Once task that fires a few days from now to draft a changelog.
- **Long-task babysitter** — interval every 5 minutes during a long migration, check progress and ping you if it stalls.

## Limits

- **No retry on failure** — a failed run is just marked `error`; the next scheduled run still happens on time.
- **No conditional execution** — you can't say "only run if there are new commits". You'd ask the AI to check that itself inside the prompt.
- **No run-history log** — only the last result is recorded. If you want history, ask the AI to append each fire's output to a note or issue.
- **Local timezone** — both cron expressions and `HH:MM` windows use the local time of the machine running Cockpit's server.

## Next

- [Sessions](/en/docs/agent/sessions/) — what scheduled-task runs look like once they happen
- [Skills](/en/docs/agent/skills/) — prompts in your scheduled task can use `/qa`, `/fx`, `/cg`, etc.
