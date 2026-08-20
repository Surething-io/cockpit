A **session** in Cockpit is one continuous conversation with one engine — tied to one Agent tab. Every tab is its own session; the whole UI is built around running many of them at once without losing track.

## Tabs are sessions

Open the Agent panel (`Cmd+1`) and look at the tab strip across the top. Each tab:

- Has its own engine pick (Claude / Codex / DeepSeek / GLM / Kimi / Ollama)
- Has its own working directory (defaults to the current project)
- Has its own conversation history
- Has its own token / cost counter
- Runs **in parallel** with every other tab — sending a message in one doesn't pause the others

Click the `+` button next to the tabs to open a new one (with a dropdown to pick the engine). Hover a tab and a `×` appears on the right to close it. Drag a tab to reorder.

## Favouriting a session

**Hover over a tab and a star appears on the top-right corner of its number chip** (the small circle at the far left of the tab) — click it to toggle (filled gold star = favourited, outlined star = not). **Not a right-click menu** — just a hover-icon click. A blank tab that has not sent a message yet shows no star: favouriting stores a session ID, and there isn't one yet.

Favourite sessions:

- Persist across Cockpit restarts (saved into the `pinned-sessions` file in Cockpit's data folder).
- Show as a **star button with a badge counter** at the bottom of the left sidebar (badge shows how many you have).
- Click the star button to open the **Favorite Sessions popover**, which floats to the right of the sidebar. Each row carries the same information as the Recent Sessions list above it: status dot (running / unread / idle), engine mark, project name, last-active time and session number, then the title, then the last message you sent. The row for your current project is highlighted. Hover a row and a card floats out to the right with the full path, the git branch and a first/last message excerpt.
- Each row has a drag handle (6-dot icon) on the left to reorder; hovering reveals a **pencil icon** to set a custom title and an **× icon** to remove it from favourites.
- Single click to jump back to the tab.

> A session favourited long ago may have aged out of the recent-sessions record. Its row then shows only the project name and the title you gave it — the status and timestamp come from that record, and it is gone.

Use this for long-running sessions you keep coming back to — your "main thread of work" across days.

## Session Browser

Click the **grid icon at the top of the left sidebar** to open the Session Browser — a full-screen modal that lists your sessions **grouped by project**:

- Search bar at the top filters projects by path keyword.
- Each project expands to reveal the sessions inside it (timestamp + a preview of the first message).
- You can also add new project folders from here.

Note: the browser is **hierarchical** (project → session), not a flat fuzzy search across every session. If you don't remember which project a conversation lived in, filter by project first, then expand.

`Enter` / clicking a session jumps to its tab (creating one if needed).

## Forking a session

Right-click any message → **Fork from here**. Cockpit creates a new tab pre-loaded with the conversation history up to that message — the server reads the original session file, truncates at the chosen message, and copies the prefix into a new file. The original tab is completely untouched.

Use cases:

- **Exploring alternatives.** "What if we used Postgres instead of Redis?" — fork and explore without losing the original thread.
- **Splitting a long session.** Once a thread has grown to many thousands of tokens, fork at a natural break point and keep going. Old context stays accessible in the original tab.
- **A/B comparison across engines.** Fork the same conversation into a DeepSeek tab and a Claude tab; ask both the next question.

## Session completion toasts

**When you're not currently focused on that project's tab**, if a session finishes generating (the AI stopped, no more tokens streaming), Cockpit shows a small toast in the **lower-left**:

> **`my-service`** finished — *"Added Redis cache with 60s TTL."*

The toast shows project name + a preview of the AI's last message. Click it to jump to that tab. Auto-dismisses after 5 seconds; hover to pause the countdown, leave and it resumes after 2 seconds.

> No toast fires for the project tab you're **already looking at** — you can already see it, no need to interrupt.

This is the single feature that makes 5+ parallel sessions tractable. Set them off, switch panels, do something else; they tap you on the shoulder when ready.

## Token & cost

Every tab tracks input / output tokens for every message and converts them to USD using the engine's price table. **Click the token button in the top bar** to open the **Token Stats** modal:

- Current session totals
- Broken down by model (per engine, per model variant)
- Daily token usage chart

Costs are estimates — final billing is whatever your provider reports. Ollama always shows `$0.00` (it's not in the price table).

## Practical layout

A common pattern after a few days:

- 3–5 favourite sessions for major workstreams — one click via the star button at the sidebar bottom.
- 2–3 transient tabs for one-off questions — close them when done.
- 1 "scratch" tab on the side for `/qa` clarification, `/cg` exploration, etc.

The Session Browser is the glue: any time you can't remember where something was, click the grid icon at the top of the sidebar.

## Next

- [Skills](/en/docs/agent/skills/) — `/qa /fx /ex /go /cg` change how the AI works within a session
- [Engines Overview](/en/docs/agent/engines/) — pick an engine per tab
