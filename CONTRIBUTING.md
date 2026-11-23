# Contributing to Archangel

Archangel is pre-alpha and built around a small, strict Trust Kernel. Contributions that tighten safety rails, fix reproducible bugs, or improve verification are welcome.

## Development Setup

**Prerequisites:** Bun 1.4.5, Node.js 22+ (only the Gate bundle runs on Node, in target repos' Actions), `git >= 2.38`.

```bash
git clone https://github.com/dgrah50/archangel.git
cd archangel
bun install
bun run check   # exactly what CI runs
```

## Key Invariants

Before opening a pull request, keep these project rules in mind:

1. **Mechanical gates decide; models only veto.** Never relax Gate bounds, protected-path checks, or fail-closed error handling to work around a failure.
2. **No compatibility shims or silent fallbacks.** Prefer clean, direct changes over dual code paths.
3. **Keep `bin/archangel-gate.mjs` fresh.** `bun run check` (and CI) verifies that the committed Gate bundle matches a fresh build. If you touch any file bundled into the Gate (`src/gate/**`, `src/core/workflow.ts`, `src/core/skills.ts`, `src/config.ts`), run `bun run build` and commit the updated `bin/archangel-gate.mjs`.
4. **Protected-path allowlist.** `test/protected-paths.test.ts` fails CI if any new file under `src/` is neither listed in `.agents/archangel.json` (`gate.protectedPaths`) nor explicitly listed as a leaf module in `.agents/leaf-modules.json`.
5. **Test first for bug fixes.** Include a failing-first test covering the bug or edge case, and verify `bun run check` passes locally.

## Submitting Changes

1. Open a focused pull request against `main` with a clear summary of the problem, the change, and how you tested it.
2. Ensure all CI checks (`Test` and `Gate`) are green and pre-commit hooks (`.pre-commit-config.yaml`) pass.
3. Merge with `bun scripts/merge-pr.ts <n>`: main's ruleset requires an up-to-date branch and auto-merge is off, so the script updates the branch, waits for checks, refuses files that lose far more lines than they gain (a stale copy silently reverting someone else's work), and squash-merges the head that passed. Never `--admin`.
4. For larger architectural changes or new work classes, open an issue first to align on the trust boundary and minimal design.
