// The sessions the tour starts side by side to show parallel runs: each is a
// prompt typed into a fresh Claude tab plus the script the mock API answers it
// with (see mock-anthropic.mjs). Tool calls are read-only and really run against
// the demo projects, so the diff the Review chapter shows stays untouched.
//
// Timing: sessions are started one after another through the UI (a few seconds
// each), so the final text steps are long enough that all of them are still
// running when the "parallel" frame is taken.

export function parallelSessions(root) {
  const api = `${root}/acme-api`;
  const web = `${root}/web-dashboard`;
  return [
    {
      project: 'web-dashboard',
      prompt: 'Add a loading state to the invoices page.',
      match: /loading state/,
      suggestion: 'Add the skeleton rows and the retry button.',
      steps: [
        { tool: 'Read', input: { file_path: `${web}/src/pages/Invoices.tsx` }, ms: 2500 },
        {
          ms: 34000,
          text: [
            'The page renders synchronously today, so there is nothing to wait on yet. Once it fetches `/invoices`:',
            '',
            '- Keep the `<h1>` and table header on screen and show **five skeleton rows** in place of the body, so the layout does not jump when data lands.',
            '- After **10 seconds** without a response, replace the skeleton with a retry button rather than spinning forever.',
            '',
            'Skeleton rows over a spinner: the table is the whole page, and its shape tells people what is coming.',
          ].join('\n'),
        },
      ],
    },
    {
      project: 'web-dashboard',
      prompt: 'Show an empty state when there are no invoices.',
      match: /empty state/,
      suggestion: 'Implement both empty states.',
      steps: [
        { tool: 'Read', input: { file_path: `${web}/src/pages/Invoices.tsx` }, ms: 3000 },
        {
          ms: 36000,
          text: [
            'Two different "empty" cases deserve different copy:',
            '',
            '| Case | Message | Action |',
            '|---|---|---|',
            '| No invoices at all | "No invoices yet" | Link to the billing docs |',
            '| A filter matches nothing | "No invoices match these filters" | **Clear filters** |',
            '',
            'Folding both into one message is the usual mistake: someone with a stale filter reads "No invoices yet" and assumes their data is gone.',
          ].join('\n'),
        },
      ],
    },
    {
      project: 'acme-api',
      prompt: 'Review src/lib/stripe.ts for error handling.',
      match: /stripe\.ts/,
      suggestion: 'Return the tagged result and map unknown to 503.',
      steps: [
        { tool: 'Read', input: { file_path: `${api}/src/lib/stripe.ts` }, ms: 3000 },
        {
          ms: 30000,
          text: [
            '`charge()` never fails, which hides three real cases:',
            '',
            '- **Card declined**: Stripe answers `402`, and we would still report `succeeded`.',
            '- **Network timeout**: the caller cannot tell whether money moved. This is exactly the retry the new `Idempotency-Key` protects.',
            '- **Rate limited by Stripe**: a `429` needs a backoff, not an immediate retry.',
            '',
            'I suggest returning a tagged result (`succeeded | declined | unknown`) and mapping `unknown` to `503` in the route, so clients retry with the same key.',
          ].join('\n'),
        },
      ],
    },
    {
      project: 'acme-api',
      prompt: 'Write tests for GET /invoices/:id.',
      match: /GET \/invoices/,
      suggestion: 'Return 404 for unknown ids, then write the tests.',
      steps: [
        { tool: 'Read', input: { file_path: `${api}/src/routes/invoices.ts` }, ms: 2000 },
        { tool: 'Glob', input: { pattern: 'test/*.test.js', path: api }, ms: 2500 },
        {
          ms: 30000,
          text: [
            'The route has two behaviours worth pinning:',
            '',
            '1. **Known id**: `200` with `id`, `status: "open"` and `currency: "usd"`.',
            '2. **Response shape**: clients have read `currency` since the last commit, so it must not disappear.',
            '',
            'I would add `test/invoices.test.js` next to the existing tests, using `node:test` like they do. There is no not-found branch yet: every id returns an open invoice. Decide whether unknown ids should return `404` before the tests lock the current behaviour in.',
          ].join('\n'),
        },
      ],
    },
    {
      project: 'acme-api',
      prompt: 'Find every place we handle currency and check they all use integer cents.',
      match: /integer cents/,
      suggestion: 'Yes, add a per-currency exponent.',
      steps: [
        { tool: 'Grep', input: { pattern: 'currency|toCents', path: `${api}/src` }, ms: 2000 },
        { tool: 'Read', input: { file_path: `${api}/src/lib/money.ts` }, ms: 2500 },
        {
          ms: 30000,
          text: [
            'Three places touch money:',
            '',
            '| File | What it does | Integer cents |',
            '|---|---|---|',
            '| `src/lib/money.ts` | `toCents()` conversion | Yes |',
            '| `src/routes/payments.ts` | charges `toCents(amount)` | Yes |',
            '| `src/routes/invoices.ts` | returns `currency` only | No amounts |',
            '',
            'No float arithmetic on amounts anywhere. One gap: `toCents` assumes two decimal places, which is wrong for `jpy` (none) and `kwd` (three). Want me to add a per-currency exponent?',
          ].join('\n'),
        },
      ],
    },
    {
      project: 'acme-api',
      prompt: 'Add a rate limit to POST /payments: 10 requests per minute per API key.',
      match: /rate limit/,
      suggestion: 'Go ahead and implement it.',
      steps: [
        { tool: 'Read', input: { file_path: `${api}/src/routes/payments.ts` }, ms: 2500 },
        { tool: 'Read', input: { file_path: `${api}/src/lib/idempotency.ts` }, ms: 2500 },
        {
          ms: 30000,
          text: [
            'Plan: a fixed-window counter per API key, stored next to the idempotency cache.',
            '',
            '- **Where**: a `rateLimit({ perMinute: 10 })` middleware in front of `POST /payments` only.',
            '- **Key**: the API key from `Authorization`, not the IP, because customers call from many hosts.',
            '- **Over the limit**: `429` with a `Retry-After` header in seconds.',
            '',
            'Replays of a stored `Idempotency-Key` do not count, so a client retrying a timed-out payment is never throttled for it.',
          ].join('\n'),
        },
      ],
    },
  ];
}
