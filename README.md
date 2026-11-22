# Archangel

Language-agnostic autonomous software factory with **repo-owned verification** (`.pre-commit-config.yaml` + `.agents/landing.json`), **native CLI subscription chains with failover** (or metered API keys), **independent cross-vendor review**, **SQLite level-triggered reconciliation**, and **1-command Paseo Handoff**.

- **Go Verification Template:** [templates/go/](./templates/go/)
- **Node/TypeScript Verification Example:** this repository's own [.agents/landing.json](./.agents/landing.json) & [.pre-commit-config.yaml](./.pre-commit-config.yaml)

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
   - Add `.pre-commit-config.yaml` and `.agents/landing.json` (plus optional `.agents/setup` for dependency install).
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
