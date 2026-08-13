# Security Policy

## Supported versions

This project ships as a single, continuously-deployed line — only the latest release/`main` is
supported. There is no long-term-support branch.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report it privately via [GitHub Security Advisories](https://github.com/tbrandenburg/agent-control-plane/security/advisories/new)
for this repository. Include:

- A description of the vulnerability and its potential impact
- Steps to reproduce (minimal repro preferred)
- Affected version/commit (`GET /version`'s `gitSha`, if applicable)

We aim to acknowledge reports within a few business days. Once a fix is available, we will
coordinate disclosure timing with the reporter before any public release notes reference the
issue.

## Scope notes

This system is designed for a **single, trusted Docker host** with **no multi-tenant isolation
guarantees beyond per-session sandbox containers** (see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full threat model and binding constraints).
Do not deploy it as a multi-tenant, internet-facing service without an independent security review
of that assumption.

Please never include credentials, tokens, or other sensitive data in a vulnerability report, issue,
pull request, or commit.
