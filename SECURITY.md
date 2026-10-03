# Security Policy

## Supported versions

Ratatoskr is under active development and currently supports the latest code on the active `main` branch.

Historical commits, abandoned branches, forks, and older deployments are not maintained as separate supported release lines, and security fixes are not guaranteed to be backported to them.

If you operate a deployment derived from Ratatoskr, compare it with current `main` when evaluating whether a reported issue has already been addressed.

## Reporting a vulnerability

Please do **not** report security vulnerabilities through a public GitHub issue, pull request, discussion, or other public thread.

Use GitHub's private vulnerability reporting for this repository:

1. Open the Ratatoskr repository on GitHub.
2. Open the **Security** area.
3. Choose **Report a vulnerability**.
4. Submit the report privately to the maintainers.

A useful report should include, where applicable:

- the affected commit, branch, workflow, command, or component;
- the security impact and who or what could be affected;
- prerequisites required to reproduce the issue;
- clear reproduction steps or a proof of concept;
- whether the issue affects local development, Railway deployment, live Discord operation, stored data, or another environment;
- any known mitigation or workaround;
- whether credentials or other sensitive material may already have been exposed.

Do not include live credentials, Discord tokens, private keys, production database contents, or unnecessary private Discord content in the report. Redact sensitive values and provide only the minimum information required to reproduce and assess the vulnerability.

If GitHub's **Report a vulnerability** control is unexpectedly unavailable, do not disclose the vulnerability publicly. Open a non-sensitive public issue only to state that the private reporting mechanism appears unavailable and ask the repository maintainers to restore or provide a private reporting path. Do not include exploit details in that issue.

## What Ratatoskr treats as security-sensitive

Security-sensitive defects include, but are not limited to:

- authorization or permission bypasses;
- forged, replayed, or stale Discord component actions that can mutate protected state without current authorization;
- unintended role assignment, privilege escalation, or access to staff-only resources;
- Discord token, client secret, service-account credential, environment-variable, or other secret exposure;
- unsafe handling of `.env` files, logs, diagnostics, backups, or production data;
- SQL injection, unsafe queries, or defects that allow unauthorized data access or corruption;
- cross-guild, cross-division, cross-team, wrong-channel, or wrong-workflow state leakage;
- interaction, webhook, or API payload handling that permits unauthorized actions;
- reconciliation, retry, idempotency, serialization, or concurrency failures that can create unauthorized or duplicate mutations;
- archive/export behavior that exposes restricted Discord history or protected artifacts to the wrong audience;
- dependency vulnerabilities that have a credible exploitable impact on Ratatoskr's deployed behavior.

Ordinary bugs that do not create a confidentiality, integrity, authorization, privilege, or meaningful availability risk should use the normal public issue process instead.

## Maintainer response process

The maintainers will handle valid vulnerability reports privately while the issue is being assessed and remediated.

The expected process is:

1. review and triage the report;
2. reproduce or otherwise validate the issue where practical;
3. identify affected Ratatoskr behavior and deployments;
4. contain immediate risk, including rotating or revoking credentials when exposure is suspected;
5. develop and validate a remediation;
6. coordinate disclosure with the reporter where appropriate;
7. publish a GitHub Security Advisory or public follow-up after remediation when public disclosure is useful and safe.

Ratatoskr does not promise a fixed acknowledgement, remediation, or disclosure SLA. Response time depends on severity, reproducibility, maintainer availability, and operational impact.

Please avoid public disclosure while a report is actively being investigated unless coordinated disclosure has been agreed with the maintainers.

## Credentials and sensitive data

Never commit or publish:

- `.env` files;
- Discord bot tokens or application secrets;
- API keys, webhook secrets, private keys, or service-account credentials;
- production database files or database dumps containing private operational data;
- private vulnerability-report details before coordinated disclosure;
- logs or screenshots containing credentials or unnecessary private Discord content.

If a credential may have been exposed, treat it as compromised and rotate or revoke it rather than assuming deletion from Git history is sufficient.

## Scope of this policy

This policy covers the Ratatoskr software and repository-managed deployment/workflow behavior.

It does not grant access to Yggdrasil Smite League private systems, production infrastructure, Discord accounts, private channels, or third-party services for security testing.

Testing must remain within systems and data you are authorized to use.
