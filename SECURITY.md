# Security Policy

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report suspected vulnerabilities privately using [GitHub Security Advisories](https://github.com/dgrah50/archangel/security/advisories/new) on this repository. Include:

- A clear description of the vulnerability and the trust boundary it crosses.
- Reproduction steps or a minimal proof of concept.
- Any affected files, commit SHAs, or configuration requirements.

## Security Model & Scope

Archangel is designed as a **single-owner, locally hosted software factory**. Its hard security boundaries are:

1. **Least-privilege GitHub App & branch protection:** The daemon's GitHub App holds only `contents:write`, `pull_requests:write`, `issues:write`, and `checks:read` (never `workflows`, `administration`, or `checks:write`).
2. **Mechanical Gate & protected paths:** Enforced independently by the local Broker, the pinned CI Gate (`ARCHANGEL_GATE_SHA`), and the Lander, using `.agents/archangel.json` read strictly from the default branch.
3. **Owner identity verification:** Author, label actor, and command checks use numeric GitHub user IDs (`ownerUserId`), never usernames.
4. **Prompt-injection & exfiltration defenses:** Read-only Scout sandboxes, scrubbed subprocess environments, whitelist-only metrics/cluster blocks, and outbound secret scanning.

### Out of Scope (Known Local Boundaries)

- **Local OS/container sandboxing:** Throwaway clones and scrubbed environments are **advisory** isolation on the owner's machine, not a multi-tenant VM/container boundary.
- **Compromised owner machine or owner `gh` token:** Interactive CLI commands (`onboard`, `workflow propose`, `pitch promote`, `gate-bump`) intentionally execute with the owner's `gh` identity.
- **Third-party CLI harnesses (`codex`, `claude`, `agy`)** outside how Archangel invokes or isolates them.
