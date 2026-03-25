# Releasing

## Prerequisites (one-time setup)

### 1. npm Access Token

Generate a token at [npmjs.com → Access Tokens → Generate New Token → Automation](https://www.npmjs.com/settings/~/tokens).

Add it to the repository:

```
GitHub repo → Settings → Secrets and variables → Actions → New repository secret
  Name:  COCKPIT_NPM_TOKEN
  Value: <your token>
```

### 2. npm login (for manual publishing)

```bash
npm login
```

## Release Process

### 1. Bump version

```bash
# patch: 1.0.169 → 1.0.170
npm version patch

# minor: 1.0.169 → 1.1.0
npm version minor

# major: 1.0.169 → 2.0.0
npm version major
```

This will:
- Update `version` in `package.json`
- Create a git commit: `v1.0.170`
- Create a git tag: `v1.0.170`

### 2. Push

```bash
git push && git push --tags
```

### 3. Automated (CI does the rest)

Pushing the `v*` tag triggers `.github/workflows/publish.yml`:

1. `npm ci` — install dependencies
2. `npm run build` — build production assets
3. `npm publish --provenance --access public` — publish to npm with [provenance](https://docs.npmjs.com/generating-provenance-statements)
4. `gh release create` — create a GitHub Release with auto-generated notes

### 4. Verify

- npm: https://www.npmjs.com/package/cockpit
- GitHub: https://github.com/Surething-io/cockpit/releases

## Manual Publishing (emergency only)

```bash
npm run build
npm publish --access public
```

## CI Overview

| Workflow | Trigger | What it does |
|---|---|---|
| `ci.yml` | PR to `main` / push to `main` | lint → build |
| `publish.yml` | push tag `v*` | build → npm publish → GitHub Release |

## Branch Protection

PRs to `main` require:
- CI passing (lint + build)
- 1 approval
- All conversations resolved
- Branch up-to-date with `main`
