# Cockpit Website

Marketing site for Cockpit — deployed at [cocking.cc](https://cocking.cc).

## Stack

- Next.js 16 (App Router, **static export** via `output: 'export'`)
- React 19 + TypeScript
- TailwindCSS v4 (reuses the brand color tokens from the main app's `globals.css`)
- Deployed on **Cloudflare Pages** + a single Pages Function for root i18n redirect

## Pages

| Route | Purpose |
|---|---|
| `/` | Pages Function reads `Accept-Language` + `lang_pref` cookie → 302 to `/en/` or `/zh/` |
| `/en/`, `/zh/` | Homepage (Hero, three panel sections, Bubbles, Extras, Built-on, Final CTA) |
| `/en/docs/`, `/zh/docs/` | Quick start / install / first run / CLI reference |
| `/en/changelog/`, `/zh/changelog/` | GitHub Releases pulled at build time |

## Local dev

```bash
cd website
npm install
npm run dev          # → http://localhost:3458
```

The Pages Function isn't active in dev — visiting `/` triggers a tiny client-side
redirect (see `components/RootRedirect.tsx`). Visiting `/en/` or `/zh/` directly
gives the same UX as production.

## Build

```bash
npm run build        # fetches GitHub Releases, then static-exports to ./out
```

Output goes to `out/`. The pre-build step (`scripts/fetch-changelog.mjs`) writes
`data/changelog.json`. If the network is down, the script writes an empty array
so the build never fails.

To raise the GitHub API rate limit, set `GITHUB_TOKEN` in the build environment
(60 → 5000 requests/hour).

## Preview a production build locally

```bash
npm run preview      # uses wrangler to emulate Cloudflare Pages + Functions
```

## Deployment (GitHub Actions → Cloudflare Pages)

Deploys are driven by [`.github/workflows/website-deploy.yml`](../.github/workflows/website-deploy.yml).

**Trigger**: only when files under `website/**` (or the workflow file itself) change.
Pushes that touch only `src/`, `bin/`, `e2b/`, etc. do not trigger this workflow.

**Flow**:

| Event | Result |
|---|---|
| `push` to `main` (touching `website/**`) | Production deploy → `cocking.cc` |
| `pull_request` (touching `website/**`) | Preview deploy → unique URL, posted to PR |
| Manual `workflow_dispatch` | Production deploy of current branch |

### One-time setup — automated via `scripts/setup-cloudflare.sh`

A single script handles 4 of the 5 steps. The only manual step is creating the
Cloudflare API token (Cloudflare doesn't allow tokens to mint new tokens).

#### Step 1 (manual): create a Cloudflare API token

Cloudflare Dashboard → My Profile → API Tokens → **Create Token** → use the
"Edit Cloudflare Workers" template, or a custom token with:

- Account → Cloudflare Pages → Edit
- Account → Account Settings → Read

Copy the token value — you'll only see it once.

#### Step 2 (automated): run the bootstrap script

The script auto-loads `website/.env` (gitignored) if present, so the easiest
flow is:

```bash
cd website
cp .env.example .env       # then edit .env to fill in the two values
gh auth login              # if not already logged in
./scripts/setup-cloudflare.sh
```

Alternatively, pass the values inline:

```bash
CLOUDFLARE_API_TOKEN=… E2B_API_KEY=… ./scripts/setup-cloudflare.sh
```

The script is idempotent — safe to re-run. It:

1. Creates the `cockpit-website` Pages project (skipped if it already exists).
2. Uploads `E2B_API_KEY` as a runtime secret for `functions/try.ts`.
3. Attaches `cocking.cc` as a custom domain.
4. Pushes `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` to your GitHub repo secrets.

After it finishes, push any commit that touches `website/**` and the workflow takes over.

#### Manual alternative (dashboard)

If you'd rather click through the dashboard:

| Step | Where | What |
|---|---|---|
| Create project | Cloudflare → Workers & Pages → Create → Pages → Direct Upload | Name: `cockpit-website` |
| Runtime secret | Pages → `cockpit-website` → Settings → Variables and Secrets | Add `E2B_API_KEY` |
| Custom domain | Pages → `cockpit-website` → Custom domains | Add `cocking.cc` |
| GitHub secrets | GitHub repo → Settings → Secrets → Actions | Add `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` |

### Verifying

After the first push to `main`:

1. GitHub Actions tab → "Deploy Website" should be green.
2. The job summary shows the live deployment URL.
3. Visit `https://cocking.cc` → should hit the i18n redirect Function and land on `/en/` or `/zh/` based on browser language.

### Rolling back

Cloudflare Pages keeps every deployment. To roll back: Pages → Deployments → pick a previous build → "Rollback to this deployment". No git revert needed.

## Cloudflare Pages setup (manual reference)

When wiring this up in Cloudflare:

| Field | Value |
|---|---|
| Production branch | `main` |
| Build command | `npm run build` |
| Build output directory | `out` |
| Root directory | `/website` |
| Node version | `20` |

### Required environment variables

| Variable | Used by | Notes |
|---|---|---|
| `E2B_API_KEY` | `functions/try.ts` | Server-side secret. Get from [e2b.dev](https://e2b.dev). Without it, `/try` returns 503. |
| `GITHUB_TOKEN` | `scripts/fetch-changelog.mjs` | Optional. Raises GitHub API rate limit from 60 → 5000/hour during build. |

### How Functions are wired

The `functions/` directory is auto-detected by Cloudflare Pages.
`public/_routes.json` whitelists only `/`, `/try`, `/try/*` — every other URL
is served directly as a static asset, so Function invocations stay near zero.

| Path | Function | Purpose |
|---|---|---|
| `/` | `functions/index.ts` | i18n redirect (`Accept-Language` + `lang_pref` cookie → 302 to `/en/` or `/zh/`) |
| `/try` | `functions/try.ts` | E2B demo handler — confirmation page + sandbox creation. Ported from `e2b/api/try.js` so the demo lives entirely under `cocking.cc`, no Vercel hop. |

## i18n strategy

- All marketing content lives in `content/messages.ts` (single TypeScript file,
  no i18n framework — KISS).
- Each page generates `/en/...` and `/zh/...` static HTML at build time.
- A `LangSwitch` component lets users toggle and persists their choice via
  the `lang_pref` cookie.
- `<html lang>` is initially `"en"` (statically rendered) and updated to
  `"zh-CN"` on `/zh/*` pages by `components/LocaleSync.tsx`.

## Brand tokens

The CSS in `app/globals.css` mirrors the design tokens from the main app's
`src/app/globals.css` (Radix Teal-9 brand color, Slate gray scale). When the
brand evolves, update both files together.

## Adding screenshots

Drop PNG files in `public/screenshots/`:

- `agent.png`, `explorer.png`, `console.png` (4:3 aspect ratio, ~1600×1200)

The `PanelSection` component shows a placeholder card until the file exists,
so layout never breaks.
