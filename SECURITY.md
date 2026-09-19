# Security Policy

## Reporting a vulnerability

Use GitHub's private reporting form:

**Security → Report a vulnerability**
<https://github.com/isnow890/usage-check/security/advisories/new>

Do not open a public issue for anything that could expose credentials or
network access. If the form is unavailable, open a regular issue that says only
that you have a report and would like a private channel.

This is a personal project maintained on a best-effort basis. There is no
response SLA. Expect an acknowledgement when the report is read, and then
either a fix or an explanation of why the report is out of scope.

## What this project handles

Stated plainly, because it decides which reports matter:

- It reads OAuth refresh tokens and billing credentials that already exist on
  the machine: `~/.codex`, `~/.claude.json`, `~/.gemini`, the codex-router
  store, and the OpenCode database.
- It sends derived access tokens to the provider quota APIs they belong to.
  Nothing is sent to a third party.
- It writes only under `~/.usage-check/` and the launchd log files.

## In scope

- Any path that reads a credential and sends it somewhere other than the
  provider it belongs to.
- Any path that writes outside `~/.usage-check/` and the launchd logs, or that
  modifies a credential store instead of reading it.
- Unauthenticated network exposure beyond what is documented below.
- A dependency doing something the source code does not.

## Known and documented, not vulnerabilities

- **The default install listens on every interface.** `next start` without
  `-H` listens on `*:4317`, so any device that can route to the machine —
  including anything else on the same Wi-Fi — opens the dashboard without
  authenticating. That is the documented default because it is what makes phone
  access work with no extra setup, and it is a deliberate trade rather than an
  oversight. Install with `--tailscale` to bind `127.0.0.1` and publish the
  dashboard to your tailnet only. The footer reports which of the two is live.
- **The OAuth client id and secret in `lib/collectors/antigravity.mjs`.** Those
  are Antigravity's own public client credentials, shipped inside the desktop
  app and reproduced by every third-party client that reads its quota. They are
  not user secrets. See the README.
- **The Gemini/Antigravity quota endpoint is undocumented**, so it can change or
  disappear without notice. That is a reliability problem, not a security one.
