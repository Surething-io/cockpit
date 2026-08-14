# e2b/

Builds the **`cockpit-demo`** sandbox template that powers the "Try Online"
demo at <https://opencockpit.dev/try>.

The handler that actually serves `/try` lives in
`website/functions/try.ts` (Cloudflare Pages Function). This directory
**only** builds the template image; it has nothing to do with serving
production traffic.

## Build

```bash
cd e2b
export E2B_API_KEY=$(node -e "console.log(require('$HOME/.e2b/config.json').teamApiKey)")
# or pull it from website/.env: source website/.env
npm install
npm run build-template
```

The script in `template.mjs`:

1. Builds a Docker image based on `node:20-slim`
2. Globally installs the latest `@surething/cockpit` from npm
3. Clones the cockpit repo into `/home/user/demo-project`
4. Sets the start command to `cock /home/user/demo-project --no-open`
5. Pushes the image to E2B's registry under template id `cockpit-demo`

A successful build prints the new template id and build id; the live
demo automatically picks up the latest published template the next time
the Pages Function calls `POST /sandboxes`. `try.ts` refers to the
template by **name** (`cockpit-demo`), not by template or build id, so a
rebuild under the same name needs no code change and no website redeploy.

## Rebuild after every npm release

Step 2 of the build pins `@surething/cockpit@latest` **at image build
time**. `latest` is resolved once, then frozen into the image. Publishing
a new version to npm therefore does *nothing* to the demo — it keeps
serving whatever version was current when the template was last built.

Nothing reports this. The sandbox boots, the demo works, it is just the
wrong version. Rebuild as part of the release (see
`skills/cockpit-release/SKILL.md`).

## Check the version in the build log

The install layer echoes the version it resolved, so the log says it
outright:

```
[builder 4/8] [stdout]: INSTALLED @surething/cockpit@1.0.263
```

A successful build showing the version you just published is enough. If
it shows the previous one, npm's registry hadn't caught up yet — wait a
minute and rebuild.

## What used to live here

`api/try.js` and `vercel.json` were a Vercel-hosted version of the demo
handler that was retired in favour of the Cloudflare Pages Function so
the entire user flow lives under `opencockpit.dev`. Don't bring them back —
the canonical handler is `website/functions/try.ts`. If you find yourself
editing `e2b/api/*` again, you're editing the wrong file.
