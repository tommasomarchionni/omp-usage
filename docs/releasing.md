# Releasing & Repository Security

Maintainer guide. Releases are fully automated; the steps below are a one-time setup.

## Release flow

1. Merge pull requests with [Conventional Commit](https://www.conventionalcommits.org/) titles (`fix:`, `feat:`, `feat!:`).
2. `release-please.yml` opens one release PR per package (`omp-usage`, `omp-usage-exporter`) with the version bump and `CHANGELOG.md`.
3. Merging a release PR creates the tag and GitHub release, then **dispatches `publish.yml`** for that package. A release created with `GITHUB_TOKEN` does not trigger `release` workflows, but `workflow_dispatch` is allowed.
4. `publish.yml` validates the tag against the package and checks out the tag. It runs build, unit and integration tests, verifies that `package.json` matches the tag, then publishes with **npm Trusted Publishing (OIDC) and provenance**. A version that is already published is skipped.

A failed publish can be re-run manually: **Actions → Publish to npm → Run workflow**, then choose the package and the existing tag.

## One-time setup

### 1. npm Trusted Publishers

For **each** package on npmjs.com (`@tommasomarchionni/omp-usage`, `@tommasomarchionni/omp-usage-exporter`): open **Settings → Trusted publishing → GitHub Actions** and enter:

| Field                | Value               |
| -------------------- | ------------------- |
| Organization or user | `tommasomarchionni` |
| Repository           | `omp-usage`         |
| Workflow filename    | `publish.yml`       |
| Environment          | `npm`               |

Then, under **Publishing access**, choose **"Require two-factor authentication and disallow tokens"** and revoke any `NPM_TOKEN` stored in the repository secrets.

Without a matching Trusted Publisher npm answers `E404 Not Found - PUT` even though the provenance statement is signed. That error explains the failed `Publish to npm` runs for 0.2.x and 0.3.x.

### 2. GitHub environment `npm`

**Settings → Environments → New environment → `npm`**:

- Required reviewers: yourself (every publish waits for approval)
- Deployment branches and tags: **Selected** → tag pattern `omp-usage-v*` and `omp-usage-exporter-v*`

### 3. Branch ruleset

**Settings → Rules → Rulesets → New ruleset → Import a ruleset** and select [`.github/rulesets/main.json`](https://github.com/tommasomarchionni/omp-usage/blob/main/.github/rulesets/main.json). It enforces, on `main`:

- pull request required, squash merge only, conversations resolved
- all CI checks green and branch up to date
- linear history, no force push, no deletion

### 4. Code security

**Settings → Code security**: enable the **Dependency graph** (required by the `Dependency review` check, which fails until it is on), Dependabot alerts, Dependabot security updates and private vulnerability reporting. Secret scanning and push protection are already enabled.

## Verifying a published package

```bash
npm view @tommasomarchionni/omp-usage-exporter dist.attestations.provenance
npm install @tommasomarchionni/omp-usage-exporter && npm audit signatures
```
