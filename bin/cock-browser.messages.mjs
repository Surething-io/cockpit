/**
 * Centralized messages & generic example pool for the browser CLI.
 *
 * ALL user-facing text (help / errors / warnings) MUST source examples from
 * EXAMPLES below. Never inline business-specific selectors or API paths.
 *
 * Single source of truth — PR review greps for case-specific leakage:
 *   grep -E '<known case keywords>' bin/cock-browser.* chrome-extension/page-core.js
 *
 * The extension generates a few messages locally (stale ref, unknown action)
 * in chrome-extension/page-core.js. Templates here are CLI-side only.
 */

// ─────────────────────────────────────────────────────────
// Generic example pool. DO NOT add case-specific values.
// ─────────────────────────────────────────────────────────

export const EXAMPLES = Object.freeze({
  selectorEmail: 'input[name="email"]',
  selectorPassword: 'input[type="password"]',
  selectorSubmit: 'button[type="submit"]',
  selectorAriaSave: 'button[aria-label="Save"]',
  selectorSearchBox: 'input[role="searchbox"]',
  selectorStatus: '[role="status"]',
  selectorContentEditable: '[contenteditable="true"]',
  selectorLoginForm: 'form#login',
  textSignIn: 'Sign in',
  textSave: 'Save',
  textSubmit: 'Submit',
  apiUsersMe: '/api/users/me',
  apiItems: '/api/items',
  apiItemsId: '/api/items/123',
});

// ─────────────────────────────────────────────────────────
// CLI-side error / warn templates
// (server-side errors come back as data.error and are printed verbatim;
//  the templates below cover errors the CLI itself originates.)
// ─────────────────────────────────────────────────────────

export const TIMEOUT_MSG = (timeoutMs, id) =>
`Timeout: no response within ${timeoutMs}ms.
  Likely cause: the page is busy (long render / streaming / network).
  Diagnose:
    cockpit browser ${id} health                    # is extension alive? (server-side, never blocks)
    cockpit browser ${id} wait --extension-ready    # wait until responsive
    cockpit browser ${id} wait --network-idle       # wait for the page to settle
  If health returns alive but evaluate still hangs, the page itself is blocked.
  Consider a service-level test if the page is driven by an async LLM/agent flow.`;

export const CONNECT_REFUSED_MSG = (baseUrl) =>
`Connection refused: Cockpit server not reachable at ${baseUrl}.
  Recover:
    1. Start the server: \`cockpit\` (prod, default port 3457) or \`cockpit-dev\` (dev, default 3456)
    2. Or set COCKPIT_PORT env var if your server runs on a non-default port.`;

// Used by F1.7 post-verify when click / key / submit succeeded per CDP
// but no observable side-effect happened in the verify window.
export const CLICK_NO_OP_WARN = (action, id, observed) =>
`⚠ ${action} succeeded per CDP but no DOM mutation / URL change / network request in ${observed.windowMs}ms.
  Likely a no-op (no real handler / portal-rendered / framework not listening).
  Observed: url-changed=${observed.urlChanged} dom-changed=${observed.domChanged} new-requests=${observed.newRequests}
  Try one of:
    cockpit browser ${id} evaluate "(() => { const el = document.querySelector('${EXAMPLES.selectorAriaSave}'); el.click(); return el.outerHTML.slice(0,200); })()"
    cockpit browser ${id} submit --form-selector '${EXAMPLES.selectorLoginForm}'
    cockpit browser ${id} fetch ${EXAMPLES.apiItems} --method POST --body '{}'`;

// ─────────────────────────────────────────────────────────
// help fragments (composed in cock-browser.mjs printHelp)
// ─────────────────────────────────────────────────────────

export const HELP_WHEN_NOT_TO_USE =
`── When NOT to use this CLI ───────────────────────────
- Testing LLM-agent driven flows end-to-end: the agent's stochastic tool
  choice and stop_reason make UI assertions flaky. Prefer a thin runtime
  script that calls the same middleware / service directly with controlled
  inputs.

- Pages that stream / re-render for >10s: evaluate calls queue behind page
  work and time out (~15s default). Run \`wait --extension-ready\` between
  acts and asserts; if it stays hung, pivot to a service-level test.

- Multi-tab / popup OAuth flows: each browser bubble tracks one tab. Open
  the secondary tab in its own bubble or stub the OAuth handshake.`;

export const HELP_INTERACTION_BY_SELECTOR = (idForExamples) =>
`Interaction by selector (preferred — refs go stale on re-render):
  click <ref|text>                Click by ref (e5#v3), or fall back to:
  click --text <substr>           Click button/link by visible text or aria-label
                                    e.g. click --text "${EXAMPLES.textSignIn}"
  click --selector <css>          Click first element matching CSS
                                    e.g. click --selector '${EXAMPLES.selectorSubmit}'
  fill <ref> <value>              Fill via ref, or:
  fill --selector <css> --value V Fill via native setter (works on React-controlled inputs)
                                    e.g. fill --selector '${EXAMPLES.selectorEmail}' --value "user@example.com"
  submit [--form-selector <css>]  form.requestSubmit() — works where key Enter is ignored
                                    e.g. submit --form-selector '${EXAMPLES.selectorLoginForm}'

  Post-verify (click / key / submit / click-by-text/-selector):
  --verify-ms <N>                 Window in ms to wait before re-probing page state
                                  (default 1000). Lower = faster but more false positives
                                  on slow-rendering React. Higher = more tolerant.
  --skip-verify (or --no-verify)  Disable post-verify for this command
                                  (e.g. legit clicks that have no observable side-effect).`;

export const HELP_FETCH =
`Backend probing (inherits page auth):
  fetch <url>                     GET, returns JSON or text
                                    e.g. fetch ${EXAMPLES.apiUsersMe}
  fetch <url> --method POST --body '{"name":"hello"}'
  fetch <url> --json $.data.id    Extract via simple JSONPath ($, .key, [N], [*])`;

export const HELP_HEALTH =
`Diagnostics:
  health                          Server-side bridge state (never blocks page).
                                  Returns: ws status, last command timestamp, pending count.
                                  Use when evaluate times out to distinguish
                                  "extension dead" vs "page busy".
  health --deep                   Also probe the page itself (may block if page is busy).`;

export const HELP_WAIT =
`Wait (synchronisation between act and assert):
  wait --text <substr>            Wait for substring in body text
  wait --selector <css> [--state visible|hidden|attached|detached]
                                  Wait for element to reach state (default: visible)
                                    e.g. wait --selector '${EXAMPLES.selectorStatus}' --state visible
  wait --url <pat>                Wait for URL match (substring or *-glob)
  wait --network-idle [--quiet-ms 500] [--max-request-age-ms 30000]
                                  Wait until 0 in-flight HTTP requests for quiet-ms.
                                  Long-running (>max-request-age-ms) are ignored
                                  so SSE / long-poll don't block.
                                    e.g. wait --network-idle --quiet-ms 800
  wait --dom-stable [--quiet-ms 300]
                                  Wait until MutationObserver sees no changes
                                  for quiet-ms (useful between act and snapshot).
  wait --extension-ready [--quiet-ms 500]
                                  CLI-side poll of \`health\` (never blocks on page).
                                  Replaces manual \`until evaluate "1+1"\` loops.
  wait --time <ms>                Sleep <ms> (escape hatch — prefer above)
  wait --ref <ref>                Wait for ref to still be connected`;

export const HELP_LIFECYCLE =
`Lifecycle / fixtures:
  status                          One-line summary: url, title, last console error,
                                  last failed request, top visible buttons.
                                  Run after a long gap before another act.
  reset [--cookies] [--storage] [--cache] [--reload]
                                  Atomic test-isolation. Combine flags as needed.
                                    e.g. reset --cookies --storage --reload
  set --type cookie --name K --value V [--domain D] [--path P] [--secure]
                                  [--same-site Lax|Strict|None] [--expires <date>]
  set --type local-storage --name K --value V
  set --type session-storage --name K --value V
                                    e.g. set --type cookie --name auth --value abc123 --secure
                                    e.g. set --type local-storage --name theme --value '"dark"'`;

export const HELP_ASSERT =
`Assert (act + assert atoms; non-zero exit on failure):
  assert --selector <css> [--text X | --visible <bool> | --attr "k=v"]
                                    e.g. assert --selector '${EXAMPLES.selectorStatus}' --text "Saved"
                                    e.g. assert --selector '${EXAMPLES.selectorSubmit}' --visible true
                                    e.g. assert --selector '[role="dialog"]' --attr "aria-modal=true"
  assert --ref <ref> --text/...   Legacy ref-based form (refs go stale; prefer --selector)
  assert --url <pat>              URL substring or *-glob match
  assert --title <substr>
  assert --console-no-errors
  assert --network --method M --url U --status S [--since <ms>]
                                  Assert a matching request occurred in networkBuffer.
                                  Status accepts ints or "2xx"/"4xx"/etc.
                                    e.g. assert --network --method POST --url ${EXAMPLES.apiItems} --status 200
  assert --fetch <url> [--fetch-method M] [--body B] [--fetch-status N]
         [--jsonpath P --equals V | --contains V | --not-contains V]
                                  Make a fetch and assert response. Inherits auth.
                                    e.g. assert --fetch ${EXAMPLES.apiItems} --jsonpath '$.count' --equals 5
                                    e.g. assert --fetch ${EXAMPLES.apiItems} --jsonpath '$[*].id' --contains 42`;
