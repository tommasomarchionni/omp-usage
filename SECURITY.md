# Security Policy

## Supported versions

Only the latest published version on npm and the most recent tagged release receive security fixes. Please always run the latest version before reporting an issue.

## Reporting a vulnerability

If you discover a security vulnerability (for example: event data leakage, path traversal in the events directory, SQL injection in the exporter, or a dependency with a known CVE affecting this project), please **do not** open a public issue.

Instead, use GitHub's private reporting flow for this repository:

1. Go to the **Security** tab of
   [github.com/tommasomarchionni/omp-usage](https://github.com/tommasomarchionni/omp-usage/security).
2. Click **"Report a vulnerability"** to open a private advisory.

You should expect an initial response within a few days. Once a fix is available, a new version will be published to npm and a GitHub Security Advisory will be issued, crediting the reporter unless anonymity is requested.

## Scope and known trade-offs

A few points are inherent to how the plugin and exporter work and are not considered vulnerabilities in themselves, but you should be aware of them:

- **Event files contain usage metadata.** They include provider, model, token counts, and reported costs. They do NOT contain prompts, responses, tool inputs/outputs, API keys, or headers. Treat the events directory as internal operational data.
- **SQLite database.** The exporter stores events and aggregates in a local SQLite file. Anyone with read access to the database file can query usage history. Restrict filesystem permissions accordingly (default 0o600 for files, 0o700 for directories).
- **Exporter HTTP endpoint.** The `/metrics` endpoint exposes aggregated Prometheus metrics. It does not expose raw events or the database. Bind to `127.0.0.1` (default) unless you explicitly configure LAN access and understand the exposure.
- **No authentication on `/metrics`.** Prometheus scrapes are unauthenticated by design. If you expose the exporter on a shared network, consider network-level restrictions (firewall, VPN, mTLS sidecar).

## Dependencies

Dependencies are kept up to date automatically via [Dependabot](.github/dependabot.yml). Every CI run includes a dependency audit.