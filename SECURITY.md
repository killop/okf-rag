# Security Policy

## Reporting a Vulnerability

Report vulnerabilities through GitHub's private security advisory feature for `killop/okf-rag`. Do not open a public issue containing credentials, exploit details, or private workspace paths.

Include the affected version or commit, reproduction steps, impact, and any proposed mitigation.

## Credential Handling

- Store provider credentials only in the Git-ignored `.okf-rag/llmwiki.env` file or process environment variables.
- Never place credentials in Raw Markdown, OKF concepts, command-line arguments, logs, `AGENTS.md`, or `CLAUDE.md`.
- Treat accidental publication as credential compromise and rotate the credential immediately.
- Daemon diagnostics are redacted, but redaction is not a substitute for correct secret storage.

## Supported Versions

Security fixes are applied to the latest `main` branch until versioned releases define a broader support policy.
