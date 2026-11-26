---
name: cockpit-hero-tour
description: Refresh the opencockpit.dev homepage hero tour — recapture its frames from the current UI with fictional data, adjust chapters and copy, and verify the player.
argument-hint: [what changed, e.g. "new sidebar" or "add a chapter for Notes"]
icon: 🎬
---

You are updating the homepage hero of `opencockpit.dev`: a short guided tour
played over real screenshots of the current Cockpit UI. Nothing in it is drawn
by hand — frames are captured by a script from a demo instance seeded with
fictional data, so refreshing it after a UI change is one command. Your job is
to rerun that pipeline, change chapters when asked, check the result with your
own eyes, and hand it back uncommitted.

`$ARGUMENTS` says what changed or what to show. If empty, assume "the UI
changed, recapture everything as is".

## How it fits together

| Piece | Path | Role |
|---|---|---|
| Seed | `website/scripts/tour/seed.mjs` | Builds `/Users/Shared/demo`: projects `acme-api` (git, uncommitted idempotency change, `node --test` tests) and `web-dashboard`, hand-written Claude transcripts, and a private HOME (`.home/`) with `projects.json` and each project's open sessions (`projects/<encoded cwd>/session.json`). Refuses any root not ending in `/demo`. |
| Mock API | `website/scripts/tour/mock-anthropic.mjs` | Scripted stand-in for the Anthropic Messages API. The real Claude CLI talks to it, so sessions really run, in parallel, with deterministic output. |
| Parallel scenario | `website/scripts/tour/parallel.mjs` | The six sessions started live (4 in acme-api, 2 in web-dashboard): prompt, keyword, steps (read-only tool calls, then slow-streamed text), and the next-prompt suggestion. |
| Capture | `website/scripts/tour/capture.mjs` (`npm run tour` in `website/`) | Seeds, starts the mock on :3472 and this checkout's **production build** on :3471 with `HOME` pointed at the demo, drives a Chrome tab via `cockpit browser`, writes `website/public/tour/<id>.webp` and `website/content/tour-frames.json` (focus rect + cursor point per frame, in % of the frame), then cleans up. |
| Player | `website/components/HeroTour.tsx` | Cross-fade → cursor travels and "clicks" → dim + zoom to the focus rect. Keeps playing on hover (deliberate); pauses on keyboard focus, off-screen, hidden tab; pause button; reduced-motion = static. Timing constants at the top (`CHAPTER_MS`, `POINT_AT`, `FOCUS_AT`, `NARROW_ZOOM`). Keyframes `tour-progress` / `tour-click` in `website/app/globals.css`. |
| Copy | `website/content/messages.ts` → `home.tour` (en + zh) | `label`, `play`, `pause`, and `chapters[]` of `{ title, caption, alt }`. **Chapters are matched to frames by index**, in the order of `FRAMES` in `capture.mjs`. |

Current chapters: `parallel` (sessions running, spinning orange numbers) →
`harvest` (all done, solid orange; one opened with its tool calls) → `engines`
(new-session engine menu) → `diff` (Explorer → Status → payments.ts) →
`console` (npm test, README preview, git log, git status bubbles).

## Hard rules

- **Fictional data only.** The frames are published. Never capture a real
  `~/.cockpit`, real sessions, real paths or a real key. Everything comes from
  `seed.mjs` / `parallel.mjs` under `/Users/Shared/demo`, and Claude only ever
  talks to the mock (`ANTHROPIC_API_KEY=sk-ant-tour-demo`).
- **Never `--dpr` / viewport-change the user's own tabs.** The script opens its
  own tab, and closes it after a run, including a failed one.
- **Do not commit** unless the user says "commit"; don't push or deploy.
- English in code, comments and console output; user-facing copy in both
  locales.

## Procedure

### 1. Pre-flight

From the repo root:

```bash
lsof -ti :3471 -sTCP:LISTEN; lsof -ti :3472 -sTCP:LISTEN   # both must print nothing
ls /Users/Shared/demo 2>/dev/null                           # must not exist (leftover = crashed run)
cockpit browser tabs >/dev/null && echo bridge-ok           # Bridge extension connected
```

Then a **fresh production build of the current checkout** — the tour shows
whatever `.next-prod` contains, not your dev server:

```bash
rm -rf .next-prod/cache && npm run build && npm run build:server
```

(Skipping the cache removal once produced frames with CSS missing.)

### 2. Make the requested change (if any)

- **Recapture only** → skip to step 3.
- **Change what a frame shows** → edit that frame's `setup()` in
  `capture.mjs`. It must leave the UI in the state to photograph and return
  `{ focus, cursor }` rects in viewport px (use the in-page helpers).
- **Add / remove / reorder a chapter** → change `FRAMES` *and*
  `home.tour.chapters` in **both** locales in the same order. Give the frame a
  `zoom` (desktop cap; the player also fits the focus rect into 88% of the
  stage, and phones use at least `NARROW_ZOOM`).
- **New demo content** (files, sessions) → `seed.mjs`. A new session that
  should be open on first load also goes into that project's `session.json`.
- **Different live sessions** → `parallel.mjs`. Keep tool calls read-only
  (Read / Grep / Glob) so the diff chapter stays as seeded; keep the `match`
  keyword unique to that prompt.

### 3. Capture

```bash
cd website && npm run tour            # ~2.5 min; prints "captured <id>" per frame
```

Debug the mock with `TOUR_MOCK_LOG=/tmp/oc-mock.log npm run tour`. On a
timeout the error includes a screenshot path of the screen at failure — read
it before guessing.

### 4. Look at every frame

Read each `website/public/tour/*.webp` (they are images — view them). Check:
real-looking content, no stray empty "New Chat" tab, nothing from your machine,
and the specific state each chapter is about (spinning rings in `parallel`,
solid orange numbers and no "Claude running" in `harvest`). Print
`content/tour-frames.json` and sanity-check that each focus rect covers what
the caption talks about. Delete any `.webp` no longer referenced.

### 5. Check the player

With the website dev server on :3458 (`npm run dev` in `website/`):

```bash
ID=$(cockpit browser open http://localhost:3458/zh/ | head -1 | awk '{print $1}')
cockpit browser $ID viewport 1440x900 && cockpit browser $ID show   # foreground: background tabs throttle rAF/transitions
cockpit browser $ID evaluate "(() => { document.querySelector('[aria-roledescription=carousel]').scrollIntoView({block:'center'}); document.querySelectorAll('[role=tab]')[0].click(); return 1; })()"
sleep 2; cockpit browser $ID screenshot          # zoomed + highlighted first chapter
cockpit browser $ID viewport iphone              # repeat for the phone layout
cockpit browser $ID viewport reset && cockpit browser $ID close
```

Then `cd website && npx tsc --noEmit && npx eslint components/HeroTour.tsx`.

### 6. Report

List what changed, frame sizes (`ls -la website/public/tour`), and that it is
uncommitted. On "commit": stage `website/public/tour/`,
`website/content/tour-frames.json` and the touched sources. If you ran
`npm run build` inside `website/`, `git restore website/data/changelog.json`
first — the build regenerates it.

## Pitfalls already paid for

- **First load opens an empty "New Chat" tab** unless the project's
  `session.json` lists open sessions — seed it, don't click it away.
- **Three panels are always mounted** side by side; off-screen panels hold
  matching text. The helper `visible()` means *on screen*, not rendered.
- **Labels share nodes with icons and ▼/▲ glyphs** — match an element's own
  text nodes (`label()`), never `textContent` of a leaf. Top-bar panel tabs
  are uppercased by CSS (`panelTab()`). The workspace sidebar is outside the
  project iframe (`topLeaf()`).
- **Synthetic Enter is ignored** by the Console input and the chat box: set
  the value through the native setter, then `cockpit browser <id> key Enter`
  (trusted input). `type` needs `--text` and was unreliable here.
- **The Claude CLI sends a `[SUGGESTION MODE …]` request after every turn.**
  The mock answers it instantly with the script's `suggestion` (it shows up in
  the chat input — nice in `harvest`) and does *not* count it as a finished
  run. Answering it with the slow script made every session run twice as long.
- **Match scripts on the opening user message only** — after a Read, file
  contents are in the conversation and can contain another script's keyword.
- **Timing:** sessions are started one by one through the UI (~3 s each), so
  final text steps are ~30 s long to keep all six running when `parallel` is
  shot (7 s after the last send). `harvest` waits for the mock's
  `stats.finished` to reach the session count, then for "Claude running" to
  disappear.
- **Single instance per data dir:** a leftover demo server (or one you started
  by hand on the same HOME) makes the next one refuse to boot. Kill it first.
- **If a run dies mid-way** and cleanup did not happen: kill whatever listens on
  3471/3472, `rm -rf /Users/Shared/demo`, and close the tour tab
  (`cockpit browser tabs` → `cockpit browser <id> close`).
