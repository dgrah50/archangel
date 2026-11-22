# Archangel

Language-agnostic autonomous software factory with **repo-owned verification** (`.pre-commit-config.yaml` + `.agents/archangel.json`), **native CLI subscription chains with failover** (or metered API keys), **independent cross-vendor review**, **SQLite level-triggered reconciliation**, and **1-command Paseo Handoff**.

- **Go Verification Template:** [templates/go/](./templates/go/)
- **Node/TypeScript Verification Example:** this repository's own [.agents/archangel.json](./.agents/archangel.json) & [.pre-commit-config.yaml](./.pre-commit-config.yaml)

## Quick Start

```bash
# Install deps, typecheck, run tests, and build
npm install
npm run test:all
npm run build
```

### Configure & Onboard a Repository

1. Copy `archangel.example.yaml` to `archangel.yaml` (gitignored), set your numeric GitHub user ID (`gh api user --jq .id`), and list your target repositories.
2. Copy `.env.example` to `.env` (auto-loaded by the CLI, `chmod 600`) and configure your dedicated least-privilege GitHub App (`contents: write`, `pull_requests: write`, `issues: write`, `checks: read` — **no** `workflows`, **no** `administration`, **no** `checks: write`).
3. On each target repository's default branch (via a human-merged PR):
   - Copy `workflows/archangel-gate.yml` to `.github/workflows/archangel-gate.yml` and pin `ARCHANGEL_GATE_SHA` to an immutable 40-char commit SHA of this repo.
   - Add `.pre-commit-config.yaml` and `.agents/archangel.json` (the version 1 workflow file; plus optional `.agents/setup` for dependency install).
   - Create factory labels (`ready-for-agent`, `factory:paused`, `factory:stop`, `needs-you`, `factory:disagree`) and an active branch protection ruleset requiring `Gate` + CI tests with squash-only merges and zero bypass actors.
4. Run preflight checks:
   ```bash
   npm run dev -- doctor
   ```
5. Run Archangel continuously (foreground or as a macOS `launchd` service):
   ```bash
   # One tick
   npm run dev -- start --once

   # Or install as an always-on macOS launchd daemon (no secrets in plist; ThrottleInterval=60)
   npm run build
   node dist/cli/index.js daemon install
   ```

### CLI Commands

- `archangel start [--once]` — run the level-triggered reconciler daemon (single-instance locked)
- `archangel daemon <install|uninstall|status>` — manage the macOS `launchd` user agent
- `archangel gate --repo <dir> --base <ref> --head <ref> [--policy-from-base]` — run the language-agnostic mechanical Gate
- `archangel doctor [--offline] [--json]` — preflight local toolchain, config, repo verification files, and live GitHub App least-privilege permissions
- `archangel metrics [--days <n>] [--repo <owner/name>] [--json]` — show funnel telemetry, lead times, vendor reviews, and deterministic actionable signals
- `archangel status [--json]` — show Threads, Phase/Mode, `Needs You` queue, daily spend, merges, and Shadow Mode agreement
- `archangel events [--topic <prefix>] [--issue <n>]` — inspect the append-only SQLite `audit_log`
- `archangel studio [--port 4111]` — start read-only loopback (`127.0.0.1`) Mastra Studio against `mastra.db`
- `archangel handoff <issue#>` / `resume <issue#>` — pause factory autonomy for Paseo takeover and resume advisory tracking
- `archangel retry <issue#>` / `abandon <issue#>` / `disagree <issue#>` / `reset-breaker` — operator controls

## The workflow file

Each repo's `.agents/archangel.json` (`"version": 1`, strict) is its whole workflow: Gate bounds and test commands, required checks, the review rubric, whether bugfixes may land on their own, and its Scouts. Values beyond the kernel's bounds (diff size, test-run counts) make the file invalid, and an invalid or missing file halts that repo (one Needs You) instead of falling back to anything. See `templates/go/.agents/archangel.json` or this repo's own file.

```json
{
  "version": 1,
  "gate": { "testFileGlobs": ["**/*_test.go"], "testCmd": "go test ./...", "protectedPaths": ["go.mod"] },
  "requiredChecks": ["Test"],
  "landing": { "bugfix": "owner" },
  "scouts": [{ "name": "bug-hunt", "schedule": "daily", "skills": ["general/bug-hunt", "go/*"], "promotion": "owner" }]
}
```

The host (`archangel.yaml`) owns resources only: identity, subscriptions, spend and rate limits, and `shadowMode` (true forces owner merges whatever the repo says).

## Scouts and bundled skills

A Scout is an entry in the workflow file's `scouts` list plus a plain-Markdown prompt at `.agents/scouts/<name>.md` (body only, no frontmatter). Skills (`archangel scout skills` lists them) live in this repo under `skills/<folder>/<name>.md` (`general/`, `go/`, `typescript/`) and are protected paths. Unknown skills fail the Scout instead of running a weaker one.

### Closing the loop: `promotion: "auto"`

By default every Scout proposal waits for the owner to add `ready-for-agent`. An owner can opt a single Scout into promoting its own proposals with `"promotion": "auto"` in its entry (an owner-merged change, since `.agents/` is protected). Limits:

- at most `scouts.maxAutoPromotionsPerDay` per repo (host config, default 1);
- the fix still has to pass the mechanical Gate (a new test failing on `main`), protected-path rules and two-vendor review;
- intake re-checks that the Scout's entry plus prompt on `main` hash to the same `trustHash` as when it filed the proposal and still say `auto`;
- if any auto-promoted fix from that Scout is disagreed with (`archangel disagree`), reverted, or turns main red, auto-promotion stops for that version. Editing that Scout's own entry or prompt (owner-merged) starts it again; edits to other parts of the file do not.
