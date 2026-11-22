# Contributing to Archangel

Archangel is pre-alpha and built around a small, strict Trust Kernel. Contributions that tighten safety rails, fix reproducible bugs, or improve verification are welcome.

## Development Setup

**Prerequisites:** Bun 1.4.5, Node.js 22+ (only the Gate bundle runs on Node, in target repos' Actions), `git >= 2.38`.

```bash
git clone https://github.com/dgrah50/archangel.git
cd archangel
bun install
bun run test:all
bun run build
```

## Key Invariants

Before opening a pull request, keep these project rules in mind:

1. **Mechanical gates decide; models only veto.** Never relax Gate bounds, protected-path checks, or fail-closed error handling to work around a failure.
2. **No compatibility shims or silent fallbacks.** Prefer clean, direct changes over dual code paths.
3. **Keep `bin/archangel-gate.mjs` fresh.** CI verifies that the committed Gate bundle matches `bun run build`. If you touch any file bundled into the Gate (`src/gate/**`, `src/core/workflow.ts`, `src/core/skills.ts`, `src/config.ts`), run `bun run build` and commit the updated `bin/archangel-gate.mjs`.
4. **Protected-path allowlist.** `test/protected-paths.test.ts` fails CI if any new file under `src/` is neither listed in `.agents/archangel.json` (`gate.protectedPaths`) nor explicitly listed as a leaf module in `.agents/leaf-modules.json`.
5. **Test first for bug fixes.** Include a failing-first test covering the bug or edge case, and verify `bun run test:all` and `bun run build` pass locally.

## Submitting Changes

1. Open a focused pull request against `main` with a clear summary of the problem, the change, and how you tested it.
2. Ensure all CI checks (`Test` and `Gate`) are green and pre-commit hooks (`.pre-commit-config.yaml`) pass.
3. For larger architectural changes or new work classes, open an issue first to align on the trust boundary and minimal design.
