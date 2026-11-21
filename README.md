# Archangel

Language-agnostic autonomous software factory (piloting on `dgrah50/gijq`) with **repo-owned verification** (`.pre-commit-config.yaml` + `.agents/landing.json`), **independent cross-vendor review** (Claude implements → OpenAI + Gemini review), **SQLite level-triggered reconciliation**, and **1-command Paseo Handoff**.

- **Architecture:** [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)
- **Glossary:** [GLOSSARY.md](./GLOSSARY.md)
- **ADRs:** [docs/adr/](./docs/adr/)
- **Pre-screened `gijq` Pilot Issues:** [docs/GIJQ-PILOT-ISSUES.md](./docs/GIJQ-PILOT-ISSUES.md)
- **`gijq` Repo Verification Templates:** [templates/gijq/](./templates/gijq/)

## Quick Start

```bash
# Install deps, typecheck, run tests, and build
npm install
npm run test:all
npm run build
```

### Configure & Run

1. Copy `archangel.example.yaml` to `archangel.yaml` (gitignored) and set your numeric GitHub user ID (`gh api user --jq .id`) and project list.
2. Copy `.env.example` to `.env` (auto-loaded by the CLI) and configure:
   - Your dedicated GitHub App credentials (`ARCHANGEL_GITHUB_APP_ID`, `ARCHANGEL_GITHUB_INSTALLATION_ID`, and `ARCHANGEL_GITHUB_PRIVATE_KEY_PATH`), installed only on target repos with:
     - `contents: write`, `pull_requests: write`, `issues: write`, `checks: read`
     - **No** `workflows`, **no** `administration`, **no** `checks: write`
   - Metered API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_GENERATIVE_AI_API_KEY`).
3. Bootstrap the `dgrah50/gijq` pilot (dry-run by default; add `--apply` when ready):
   ```bash
   # Preview all 6 labels & 10 pre-screened issues
   npm run pilot:setup -- --dry-run

   # Print the exact GitHub branch ruleset JSON for main
   npm run -s pilot:setup -- --print-ruleset

   # Install the pinned Gate workflow + gijq's .pre-commit-config.yaml & .agents/landing.json
   npm run pilot:setup -- --install-workflow /path/to/gijq --apply
   ```
4. Run preflight checks (verifies local toolchain, config, repo `.pre-commit-config.yaml` / `.agents/landing.json`, and audits live GitHub App least-privilege permissions):
   ```bash
   npm run dev -- doctor
   ```
5. Start Archangel in Shadow Mode (recommended under `caffeinate -i` on macOS laptops):
   ```bash
   caffeinate -i npm run dev -- start
   ```

### CLI Commands

- `archangel start [--once]` — run the level-triggered reconciler daemon (single-instance locked)
- `archangel gate --repo <dir> --base <ref> --head <ref> [--policy-from-base]` — run the language-agnostic mechanical Gate (reads repo `.pre-commit-config.yaml` and `.agents/landing.json` strictly from `base`)
- `archangel doctor [--offline] [--json]` — preflight local toolchain, config, repo verification files, and live GitHub App least-privilege permissions
- `archangel studio [--port 4111]` — start read-only loopback (`127.0.0.1`) Mastra Studio against `mastra.db`
- `archangel status [--json]` — show Threads, Phase/Mode, `Needs You` queue, daily spend + reserved budget, merges, circuit breaker, and Shadow Mode agreement
- `archangel events [--topic <prefix>] [--issue <n>]` — inspect the append-only SQLite `audit_log`
- `archangel handoff <issue#>` — enqueue/execute daemon handoff, push pending commits via Broker, pause factory, and launch Paseo worktree with Recap
- `archangel resume <issue#>` — verify Paseo is stopped, refresh issue-body hash, and resume advisory Gate/Review tracking (owner merges manually)
- `archangel retry <issue#>` — retry a `needs_you` thread (refreshes issue-body hash and clears `needs-you` / `factory:paused`)
- `archangel abandon <issue#>` — stop a thread permanently and clean up active work
- `archangel disagree <issue#>` — record a Shadow Mode disagreement (`factory:disagree`)
- `archangel reset-breaker` — reset the global landing circuit breaker after fixing red `main`
