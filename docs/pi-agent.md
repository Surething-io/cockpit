# Embedded Pi agent

Cockpit embeds `@earendil-works/pi-coding-agent` 1.4.0 for Ollama, DeepSeek,
Kimi and GLM. Claude continues to use Claude Agent SDK; Codex continues to
use its app-server. Node.js 22.19 or newer is required.

## Ownership

Pi owns execution, native tools, retries, compaction and session persistence.
Cockpit owns input admission, dispatch, chat presentation, project/tab metadata,
credentials and tool snapshots. The adapter projects native messages into UI
events without writing another transcript.

Native sessions live at:

```text
$COCKPIT_HOME/pi/sessions/--<Pi-encoded-project-path>--/
  <timestamp>_<session-id>.jsonl
```

`COCKPIT_HOME` defaults to `~/.cockpit`. Sessions share one project directory
across Pi providers. Provider changes apply on the next send and are recorded
as native `model_change` entries. The latest native selection initializes the
provider/model controls after reload. Old built-in agent stores are neither
read nor migrated.

Cockpit injects its configured endpoints and runtime API keys. It does not
copy keys into Pi auth storage. Catalog metadata, including compatibility
and thinking settings, is retained for known models. Unknown compatible
models use conservative context/output limits and text input.

Runtime Pi imports occur inside Effect SDK operations using native dynamic
imports. This supports both the tsx development entry (CommonJS workspace
modules) and the bundled ESM production server without requiring Pi via CJS.

## Integration

- `effect/piAgentLive.ts`: scoped SDK lifetime, cancellation and queued input.
- `effect/piRunInputLive.ts`: the single FIFO, input ownership and atomic closure.
- `effect/piSessionLive.ts`: native discovery, selection and branch reading.
- `effect/piSessionEditLive.ts`: native forks and complete-turn deletion.
- `server/engines/piEvents.ts`: presentation and snapshot event projection.

Pi's native tools are used directly. Tool path presentation follows the pinned
Pi resolver's normalization of @ prefixes, home directories, file URLs, Unicode
spaces and Windows shell paths. Contract tests compare projection with paths
received by the real native write tool's filesystem operations. Bash adds Cockpit's sanitized environment
and session identifiers through Pi's spawn hook. Project context files and
skills use Pi discovery. Automatic extension and prompt-template discovery
are disabled; Cockpit continues to expand its own slash commands.

The input controller registers before SDK initialization. It retains each input
until a serial `prompt()` and `waitForIdle()` finish, rather than transferring it
to Pi's follow-up queue. Once Pi is idle, checking an empty queue and sealing
admission happen synchronously. RunHub distinguishes closed input from an engine
without input support, so a send after closure waits for the writer lease and
starts another run. Cancellation or failure retains unfinished input as native
custom metadata, visible as a history notice and excluded from model context.
If cancellation precedes the first conversation message, scope teardown writes
Pi's native header and entries to its otherwise deferred session file. Recovery
therefore does not depend on live error events, which Stop may already close.
Ollama wire requests normalize null message content to an empty string through
Pi's provider-request extension; native messages retain Pi's original format.

Delegation status remains running while the writer lease is held, including
Stop-to-cleanup persistence. It cannot infer completion from an older disk image
during that window. Native undelivered-input metadata represents unresolved work.
A later unrelated success does not clear that record; the status response includes
the outstanding notice instead of presenting an older reply as completion.
Single-turn forks copy the selected messages plus active-branch context edits
that target those messages, including edits appended in later turns. Target IDs
are remapped so Pi retains omission/replacement semantics in the new session.

Live usage and the final result share one run-local accumulator. Each finalized
assistant response, including tool steps and retry responses, contributes once;
previous session usage is excluded. Replayed completion events are deduplicated
by the finalized message identity supplied by Pi.

Independent tasks filter prior model context through an inline Pi extension,
while retaining the native conversation for display. Normal runs use Pi's
compaction. Browsing shows the selected branch's full history; resuming uses
Pi's compaction-aware context. Deleting a turn removes its messages and stale
summaries before rebuilding native parent links, so deleted text cannot return
through a summary.

## Verification

`effect/piAgentLive.test.ts` runs the actual SDK against a local faux provider.
It covers native storage, cross-provider continuation, tools, usage, independent
tasks, queued input, compaction restore, forks, deletion, errors and cancellation.
It requires no provider credentials or paid requests.
