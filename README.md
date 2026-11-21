# Archangel

Autonomous software factory for Go repositories (piloting on `dgrah50/gijq`) with **mechanical merge gates**, **independent cross-vendor review** (Claude implements → OpenAI + Gemini review), **SQLite level-triggered reconciliation**, and **1-command Paseo Handoff**.

- **Architecture:** [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- **Glossary:** [GLOSSARY.md](./GLOSSARY.md)
- **ADRs:** [docs/adr/](./docs/adr/)
- **Pre-screened `gijq` Pilot Issues:** [docs/GIJQ-PILOT-ISSUES.md](./docs/GIJQ-PILOT-ISSUES.md)

## Quick Start

```bash
# Install deps & run full TypeScript + Go Gate test suite
npm install
npm run test:all
npm run build

# Build the zero-dependency Go mechanical Gate binary
(cd gate && go build -o archangel-gate ./cmd/archangel-gate)
```

### Configure & Run

1. Create a GitHub App installed only on `dgrah50/gijq` with permissions:
   - `contents: write`, `pull_requests: write`, `issues: write`, `checks: read`
   - **No** `workflows`, **no** `administration`, **no** `checks: write`
2. Enable a GitHub ruleset / branch protection on `dgrah50/gijq` `main` (zero bypass actors) requiring `Gate`, `Test (ubuntu-latest)`, and `Test (macos-latest)` from GitHub Actions, and add [workflows/archangel-gate.yml](./workflows/archangel-gate.yml).
3. Copy `.env.example` to `.env` and fill in your GitHub App credentials, numeric GitHub user ID (`gh api user --jq .id`), and metered API keys.
4. Start Archangel in Shadow Mode (recommended under `caffeinate -i` on macOS laptops):

```bash
caffeinate -i npm run dev -- start
```

### CLI Commands

- `archangel start [--once]` — run the level-triggered reconciler daemon
- `archangel status [--json]` — show Threads, `Needs You` queue, daily spend, merges, circuit breaker, and Shadow Mode agreement
- `archangel events [--topic <prefix>] [--issue <n>]` — inspect the append-only SQLite `audit_log`
- `archangel handoff <issue#>` — abort active run, push pending commits via Broker, pause factory, and launch Paseo worktree with Recap
- `archangel resume <issue#>` — verify Paseo is stopped and resume advisory Gate/Review tracking (owner merges manually)
- `archangel disagree <issue#>` — record a Shadow Mode disagreement (`factory:disagree`)
- `archangel reset-breaker` — reset the global landing circuit breaker after fixing red `main`
