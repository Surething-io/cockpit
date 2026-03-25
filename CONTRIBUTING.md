# Contributing to Cockpit

Thanks for your interest in contributing! Here's how to get started.

## Getting Started

1. **Fork** this repository
2. **Clone** your fork locally:
   ```bash
   git clone https://github.com/<your-username>/cockpit.git
   cd cockpit
   ```
3. **Install dependencies**:
   ```bash
   npm install
   ```
4. **Start the dev server**:
   ```bash
   npm run dev  # runs on port 3456
   ```

## Development Workflow

1. Create a feature branch from `main`:
   ```bash
   git checkout -b feat/your-feature
   ```
2. Make your changes
3. Run lint before committing:
   ```bash
   npm run lint
   ```
4. Commit using [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat:` new feature
   - `fix:` bug fix
   - `docs:` documentation only
   - `refactor:` code change that neither fixes a bug nor adds a feature
   - `chore:` maintenance tasks
5. Push to your fork and open a Pull Request

## Pull Request Guidelines

- Keep PRs focused — one feature or fix per PR
- Fill out the PR template
- Make sure lint passes
- Add a clear description of what changed and why
- Link related issues using `Fixes #123`

## Reporting Bugs

- Use the **Bug Report** issue template
- Include steps to reproduce
- Include your environment info (OS, Node.js version, Cockpit version)

## Code Style

- TypeScript with strict mode
- React functional components
- TailwindCSS for styling
- Run `npm run lint` to check

## Questions?

Open an issue with the question label and we'll be happy to help.
