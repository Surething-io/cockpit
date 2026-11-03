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
across Pi providers. The engine/provider is selected when creating a session;
the chat has no provider-switching control. Models within that provider can
still change on the next send, recorded as native `model_change` entries.
The latest native selection restores the session engine and model after reload.
Old built-in agent stores are neither
read nor migrated.

Cockpit injects its configured endpoints and runtime API keys. It does not
copy keys into Pi auth storage. Catalog metadata, including compatibility
and thinking settings, is retained for known models. Unknown compatible
models require an audited capability definition or complete explicit configuration; no arbitrary context/output defaults are applied.

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

## Dynamic internal subagents

The parent exposes a `subagent` tool with no predefined roles or `agents/`
registry. It accepts `task` and optional `instructions`, `name` (display only),
`model`, `tools`, and `cwd`. Alternatively, `tasks` runs up to eight tasks with
four concurrent children, and `chain` runs sequentially with `{previous}`
substitution. Failed chain steps stop the chain; parallel failures do not
cancel successful siblings. Model overrides use `provider/model` (or a bare
model ID within the current provider). Other providers use Cockpit's existing
saved credentials and regional endpoints.

This adapts the subprocess/JSON protocol and single/parallel/chain semantics of
Pi 1.4.0's official `examples/extensions/subagent`. It replaces the example's
predefined-agent lookup with per-call instructions, uses Effect-scoped process
ownership, and bridges the embedded runtime's effective model configuration.
Pi still owns every child's agent loop, tools and provider requests. `/dl`,
Claude and Codex do not participate in internal Pi subagent dispatch.

`bin/pi-subagent-entry.mjs` resolves the installed dependency's bundled CLI from
its exported RPC entry. It runs that exact Pi version, without a global CLI or
PATH lookup. The child inherits `PI_CODING_AGENT_DIR=$COCKPIT_HOME/pi`, sanitized
shell variables, and the parent run ID. Each child receives an explicit native
`--session` path and `--session-dir` under the parent session's directory:

```text
pi/sessions/--project--/
  <timestamp>_<parent-id>.jsonl
  <parent-id>/subagents/<child-id>/
    <timestamp>_<child-id>.jsonl
    meta.json
```

The host creates a native header and a custom instructions entry before launch,
so failed starts and cancellations retain an inspectable record. The metadata
links the spawning tool-call ID, child ID, relative transcript path, model,
label and completion status. Instructions also use private temporary files
under `pi/tmp/` for CLI input, removed only after the process exits.

The explicit `bin/pi-subagent-provider.mjs` extension receives the effective
model metadata through the child environment; the same metadata builder serves
parent and child. It does not rewrite shared `models.json` or `auth.json`, so
parallel children cannot overwrite each other's provider definitions. The key
travels in the child environment and becomes Pi's in-process runtime override,
then is removed from that environment before model tools run. It is never put
in the spawned OS argument list or written to the prompt/config files. Ollama's
null-content compatibility is preserved in the child. Automatic catalog network
refresh is disabled because the effective definition is already supplied.

Children start with an independent context, retain Pi project-context discovery,
and expose only the selected native tools. Extension/MCP discovery is disabled;
children have no nested `subagent` tool. The installed CLI runs in native RPC
mode. The host sends a prompt over stdin, then closes stdin after `agent_settled`
to dispose the idle runtime. Cancellation sends native `abort` and waits for its
idle acknowledgement so partial assistant messages reach native history first.
After three seconds without exit, the host sends SIGTERM, then SIGKILL after
another three seconds. Temporary resources remain until actual process exit.
If forced termination or protocol failure prevents native message persistence,
the host retains bounded partial output as explicitly incomplete Cockpit custom
metadata after the writer exits. History projection shows this fallback without
pretending it is a provider-completed assistant message.

Text/tool progress updates the existing parent tool card without settling it.
Final summaries and per-child usage are persisted by Pi in the parent tool
result; intermediate progress is live-only. Parent usage continues to count
parent assistant responses, with child usage reported separately. The parent
subagent card opens the existing transcript modal; parallel/chain children have
individual selectors. It reads native history through `session-by-path`, polls
while the parent call runs, and survives page reloads. Child IDs are resolved
through the parent's metadata; the endpoint never accepts a transcript path.
Children stay out of top-level session lists and search. Forks copy only histories
referenced by retained tool calls into independent files; deleting a turn prunes
its children. Retention groups timestamped parent files and artifact directories
by the native header ID and removes them together, respecting pinned parents.
The UI views child histories; resuming a child as a top-level conversation is not
part of this flow.

Verification includes real parent SDK → real child CLI → local provider,
configuration inheritance, cross-provider metadata, parallel ordering, chains,
failures and cancellation/cleanup. No provider credentials or paid calls are
needed for these tests.

## Bash execution

Parent SDK and child CLI Bash tools allow Pi launches. There is no shell parser
or Pi-specific tool-call blocker. The parent prompt recommends the subagent tool
for managed results, cancellation, usage and native child history; this is guidance,
not enforcement. Processes launched directly through Bash do not automatically
receive the subagent tool's lifecycle and UI history integration.

## Audited model capabilities and incomplete responses

`server/engines/shared/piModelCapabilities.ts` is the audited service table,
checked on 2026-11-02. It covers current DeepSeek Flash/Pro, six Kimi Coding
Plan IDs, and the eleven GLM IDs offered by the configured service. Each entry
records its documentation URL, date, input modalities, thinking contract,
context window and output ceiling when published. DeepSeek's documented
`deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` aliases use the Flash
contract while retaining the requested wire ID. No fuzzy name matching is used.

The resolver combines that table with Pi's exact native catalog and explicit
operator definitions. Kimi reads `/models` on the configured endpoint to respect
the service-reported context window; documented lower-tier limits apply if the
field is absent. Known ceilings still bound service values. Ollama reads
`/api/show` capabilities and `num_ctx`, plus `/api/ps` for loaded context. A
model's theoretical context length alone does not prove the runtime window.
Embedding-only models are rejected. OpenAI-compatible local servers that cannot
report these fields need an explicit definition.

The default request output budget is an explicit policy of 32,768 tokens, capped
by the known service maximum and available window. It is separate from the
model's maximum output. Coding Plan entries without a published independent
output maximum keep that field unknown; the policy is not recorded as their
maximum. Required thinking stays enabled and Kimi sampling fields are omitted.
Parents and same-model children share the already resolved definition; selecting
another model resolves that model independently.

Unknown IDs fail with an actionable error. Configure an exact native entry in
`$COCKPIT_HOME/pi/models.json` (actual limits must match your serving runtime):

```json
{
  "providers": {
    "ollama": {
      "api": "openai-completions",
      "baseUrl": "http://localhost:11434/v1",
      "models": [{
        "id": "my-model:tag",
        "name": "My local model",
        "contextWindow": 65536,
        "maxTokens": 32768,
        "input": ["text"],
        "reasoning": false,
        "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }
      }]
    }
  }
}
```

Use `models` entries, not native `modelOverrides`, for managed runs: native CLI
modelOverrides take precedence after extension registration and could otherwise
make parent/child limits diverge. Required-thinking service contracts cannot be
disabled by an override. Configuration is read only; Cockpit never rewrites it
or places credentials in model definitions.

After Pi's own recovery finishes, the parent checks the last native assistant
entry rather than only model context. A terminal `length` response can have been
omitted from context by Pi; it still fails the run and keeps its partial output.
Children return stop reason, process exit/signal and partial text, and persist a
`truncated` status instead of an unexplained `(0)` failure. Native history
projection adds an incomplete-response notice and identifies responses Pi has
excluded from future context. Clone/cut preserve the native stop reasons and
remapped context edits, so those notices remain accurate after copying.
Claude and Codex retain their native SDK execution and result/error event paths.

## Review follow-ups

Managed model resolution preserves provider headers and model headers as separate
layers, plus supported model fields such as sampling parameters and prompt-cache
settings. The parent registers both layers, and the same resolved values are
passed to its CLI child. Provider compatibility settings merge before model
compatibility settings, including their nested routing/template fields.
Cockpit's engine endpoint and credential store remain authoritative. A model-level
endpoint must match that engine endpoint. Unsupported native configuration fields,
non-chat APIs, dynamic header commands/environment interpolation and conflicting
sampling overrides fail explicitly rather than being silently discarded.

Both prefix clones and single-turn excerpts copy context edits by the retained
message references across the full source branch. Prefix clones skip edits
already retained by Pi's native branch writer, then append later relevant edits
in source order. Edits of omitted messages stay omitted; message IDs and edit
references remain valid, and the latest exclusion/restoration wins.

Turn deletion also retains context edits by their surviving message targets,
including edits appended inside a removed turn. Relative edit order is preserved.
Local child output truncation is an explicit error and truncated status, even
when the provider stopped normally; chains stop and full native history remains
viewable. Small context windows reserve at most half their tokens for input when
setting the output ceiling, rather than imposing a 4096-token minimum window.
Only known provider prefixes qualify child model selections; other slashes remain
part of the current provider's model ID.

Sampling configuration accepts only temperature, top_p, top_k, min_p,
frequency_penalty, presence_penalty, repetition_penalty and seed, with finite
numeric values. Structural fields, length controls and unknown sampling keys
fail before SDK or CLI requests; native context accounting may further lower
the configured output budget. Tests inspect real parent/child HTTP payloads.

Child output collection keeps a bounded current-message buffer shared by live
progress and failure results. Protocol events above 2 MiB explicitly truncate
and fail, retaining already received text instead of returning an older answer.

Forked child files contain only complete JSONL records from the read snapshot.
Active source children become interrupted snapshots with an explicit native
custom notice. Their metadata never claims ownership of the original process;
source completion or cancellation cannot modify these independent copies.

Protocol parsing, negative RPC responses and stdin failures notify the Effect
process owner immediately, even if the CLI remains alive. Normal completion,
protocol failure and external cancellation all release the same acquisition once.
That owner performs abort / bounded TERM / KILL and waits for actual close before
retaining partial history or releasing temporary files. No IPC error handler owns
an independent termination path. Real TERM-resistant process tests cover malformed
JSON, oversized events, RPC errors and simultaneous external cancellation.

The IPC boundary treats parsed JSON as unknown data. Assistant content, stop
reason, optional error text and consumed usage/cost counters are validated and
normalized before the last-response snapshot or counters change. Invalid endings
leave current partial text and previous validated accounting intact. The close
callback only reads normalized text and always settles the result behind an
exception boundary, including a final record without a newline. Isolated-host
regressions verify malformed structures cannot terminate the Cockpit process;
TERM-resistant tests also cover malformed endings racing with cancellation.

### Repeated subagent tool cycles

Only native CLI children load `bin/pi-subagent-progress.mjs`. The embedded parent
has no progress detector. Each child independently fingerprints ordered tool
batches by tool names, canonical arguments, returned content and error flags;
call IDs and timestamps do not affect matching.

The retained thresholds are explicit: three identical batches, or three repeats
of a cycle up to eight batches, produce a visible `cockpit.execution-notice`.
The next model request receives corrective feedback. Continuing that cycle stops
only the child with `no_progress`; changed work can continue and finish. A child
gets one warning; a later detected cycle stops without another warning. This
checks exact repeated behavior, not semantic similarity or all infinite loops.

A child stop event also wakes the existing Effect process owner: native abort,
then the existing TERM/KILL timeouts, followed by actual process exit. This covers
automatic compaction starting after the extension aborts the stopping turn.
Partial output, the stop reason and native child history remain inspectable.
Parallel siblings continue independently; chains stop on a failed child as before.
There are no shared request/token budgets or same-task retry quotas. Provider
transport, retries, compaction and usage reporting use the original native paths.
No budget IPC, receipt journal or post-exit usage reconciliation is involved.
Bash remains unrestricted, including direct Pi CLI commands. Claude/Codex are
unchanged.
