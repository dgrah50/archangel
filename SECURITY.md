# Security Policy

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for security vulnerabilities.

Instead, report suspected vulnerabilities privately using [GitHub Security Advisories](https://github.com/dgrah50/archangel/security/advisories/new) on this repository. Include:

- A clear description of the vulnerability and the trust boundary it crosses.
- Reproduction steps or a minimal proof of concept.
- Any affected files, commit SHAs, or configuration requirements.

## Security Model & Scope

Archangel is designed as a **single-owner, locally hosted software factory**. Its hard security boundaries are:

1. **Least-privilege GitHub App & branch protection:** The daemon's GitHub App holds only `contents:write`, `pull_requests:write`, `issues:write`, and `checks:read` (never `workflows`, `administration`, or `checks:write`). Its one push that is not a factory branch is `publishAssets`, which can only add `prs/<n>/<sha256>.png` and `pitches/<n>/<sha256>.png` files to the orphan branch `archangel/assets` (re-encoded screenshots, embedded by commit-pinned URLs); it refuses any other ref or path.
2. **Mechanical Gate & protected paths:** Enforced independently by the local Broker, the pinned CI Gate (`ARCHANGEL_GATE_SHA`), and the Lander, using `.agents/archangel.json` read strictly from the default branch.
3. **Owner identity verification:** Author, label actor, and command checks use numeric GitHub user IDs (`ownerUserId`), never usernames.
4. **Prompt-injection & exfiltration defenses:** Read-only Scout sandboxes, scrubbed subprocess environments, whitelist-only metrics/cluster blocks, and outbound secret scanning.

### Preview install trust model

A preview (PoC build, or a factory PR head shot for screenshots) installs the repo's `preview.install` before it runs, and the code being installed is agent-written. The install therefore never runs on the host:

- It runs under a dedicated macOS `sandbox-exec` install profile. Reads: the workspace, one per-run directory (which is `HOME`, `TMPDIR` and the package-manager cache, deleted afterwards), the read-only toolchain and the install binary itself. Nothing else under the user's home is readable. Writes: the workspace and that directory only.
- **Outbound network is open during install.** Seatbelt filters by IP and port, not hostname, so registry hosts cannot be allowed alone. What bounds this is that the install has no credentials in its env, no home access, and (by default) no scripts, so there is nothing to send and nothing local to read.
- The env is only a minimal `PATH`, `HOME`, `TMPDIR` and the cache dirs.
- Lifecycle scripts are off by default: `--ignore-scripts` is added for bun, npm and pnpm, and yarn gets its env switches. A different declared install command still runs inside the profile. Only the owner can turn scripts on, with `preview.allowInstallScripts: true` in `.agents/archangel.json` on the default branch; they then still run inside the profile.
- If the platform cannot sandbox the install (not macOS), the preview refuses. There is no unsandboxed fallback.

### Out of Scope (Known Local Boundaries)

- **Local OS/container sandboxing:** Throwaway clones and scrubbed environments are **advisory** isolation on the owner's machine, not a multi-tenant VM/container boundary.
- **Compromised owner machine or owner `gh` token:** Interactive CLI commands (`onboard`, `workflow propose`, `pitch promote`, `gate-bump`) intentionally execute with the owner's `gh` identity.
- **Third-party CLI harnesses (`codex`, `claude`, `agy`)** outside how Archangel invokes or isolates them.
