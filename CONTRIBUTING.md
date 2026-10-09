# Contributing

Thanks for considering a contribution to this project.

## Ways to contribute

- **Bug reports**: open an issue using the "Bug report" template. Include relevant logs, environment variables (never paste secrets), and steps to reproduce.
- **Feature requests**: open an issue using the "Feature request" template.
- **Documentation**: the docs live in `docs/` and are built with [MkDocs Material](https://squidfunk.github.io/mkdocs-material/). Typo fixes and clarifications are always welcome.
- **Code**: see the workflow below.

## Development setup

```bash
git clone https://github.com/tommasomarchionni/omp-usage.git
cd omp-usage
npm install
cp .env.example .env
# edit .env with your configuration
```

Build and test locally:

```bash
npm run build
npm run test
npm run lint
npm run typecheck
```

## Running the test suite locally

The full suite runs in Node.js (no Docker required):

```bash
npm run test
```

This runs:
1. **ESLint** on all packages — static analysis for common mistakes.
2. **TypeScript typecheck** — catches type errors.
3. **Vitest unit tests** — exercises core logic.

## Documentation site

Preview the documentation site locally:

```bash
npm run docs:serve
```

Then open `http://127.0.0.1:8000/`.

## Pull request checklist

- [ ] `npm run test` passes locally.
- [ ] `npm run lint` passes.
- [ ] `npm run typecheck` passes.
- [ ] New environment variables are documented in `.env.example` and `docs/configuration.md`.
- [ ] Behavioral changes are reflected in the relevant `docs/*.md` page.
- [ ] `CHANGELOG.md` has a new entry under "Unreleased".

## Commit style

This project loosely follows [Conventional Commits](https://www.conventionalcommits.org/) (`fix:`, `feat:`, `docs:`, `chore:`, ...) to keep history and the changelog readable, but this is a guideline, not a hard requirement enforced by CI.

## Code of Conduct

By participating in this project, you agree to abide by the [Code of Conduct](CODE_OF_CONDUCT.md).