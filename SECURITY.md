# Security Policy

## Supported Versions

graphCTX is pre-1.0 and ships from `main`. Security fixes are applied to the
latest commit on `main` and the most recent published release.

| Version | Supported |
| ------- | --------- |
| `main`  | yes       |
| latest release | yes |
| older releases | no  |

## Reporting a Vulnerability

Please do **not** open a public GitHub issue for security problems.

Instead, report privately by either:

- Opening a [GitHub private security advisory](https://github.com/coder-company/graphCTX/security/advisories/new), or
- Emailing the maintainers at `security@coder-company.dev`.

Include in your report:

- A clear description of the issue and its impact.
- Steps to reproduce, ideally with a minimal proof of concept.
- The graphCTX commit hash or version where you observed the issue.
- Any suggested mitigation, if you have one.

You can expect:

- An acknowledgement within **3 business days**.
- A triage and severity assessment within **7 business days**.
- A coordinated disclosure timeline once a fix is identified, typically no
  longer than 90 days from the initial report.

## Scope

In-scope:

- The graphCTX CLI, embedded SQLite store, retrieval and injection planner,
  adapters, and MCP stdio server in this repository.

Out of scope:

- Vulnerabilities in third-party dependencies (please report upstream).
- Issues that require a malicious operator on the same local machine as the
  user (graphCTX is a local-first tool and assumes the local user is trusted).
- Denial of service from arbitrarily large user inputs.

## Hardening Notes

- graphCTX runs fully offline by default and makes no required outbound
  network calls.
- LLM extraction is opt-in and uses bounded, cancellable requests.
- All persistent state lives under `.graphctx/` in the target repo and is
  never transmitted off the machine.

Thanks for helping keep graphCTX and its users safe.
