# Security policy

## Reporting a vulnerability

Please do not report security problems in public issues, pull requests or discussions.

Report them privately through GitHub's vulnerability reporting:
[open a private report](https://github.com/MouseWerk/Kalzit/security/advisories/new) (the
"Report a vulnerability" button on the repository's
[Security tab](https://github.com/MouseWerk/Kalzit/security)). Only the maintainers can see the
report.

Helpful details:

- the affected version or commit, and the operating system (Windows or Linux);
- what an attacker can do, and which role or access they need (signed out, viewer, editor, ...);
- steps to reproduce, ideally with a minimal configuration or request;
- whether the problem is already public.

We confirm a report as soon as we can, keep you informed while we work on a fix, and credit you in
the advisory unless you prefer otherwise. Please give us a reasonable time to release a fix before
you disclose the problem.

## Supported versions

Kalzit has no release yet. Security fixes go into the `main` branch; once releases exist, this
section will name the versions that receive fixes.

## Scope

In scope is the code in this repository: the server, the embedded web interface and the
documented configuration. Examples of what we treat as security problems:

- bypassing authorization: reading or changing a resource without the permission the API
  documents for it ([docs/api/access.md](docs/api/access.md));
- a query that writes to a data source despite the read-only checks;
- reaching a target the target policy refuses (Kalzit's own database or data directory, cloud
  metadata addresses, files outside allowed directories);
- secrets (data source passwords, tokens, the secrets key) leaking into responses, logs or the
  audit log;
- cross-site scripting, request forgery or session problems in the web interface.

A data source login with more rights than it needs is a configuration choice; Kalzit's read-only
checks are a second line of defence behind a read-only database account, as the data source forms
say.
