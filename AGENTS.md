# Working on Archangel

Run `bun run check` before you push: it is exactly what CI runs. Project invariants and the merge procedure (`bun scripts/merge-pr.ts <n>`) are in `CONTRIBUTING.md`.

## Tests: few, and each one earns its place

Write a test only when it locks down behavior that something relies on, and that a competent maintainer could plausibly break without noticing. If the code is simple enough to maintain without a test holding it down, don't write the test. Trust future maintainers.

A test is worth keeping only if it fails on a real regression and only on a regression. Do not write tests that:

- restate the code: the expected value comes from the same logic, or it mirrors the implementation line by line;
- assert the implementation: private state, internal call order, which helper ran;
- can never fail: they test the browser, the type system, a library, or a mock of the unit under test;
- guard the past: removed code stays removed, or a moved file is absent from its old path;
- duplicate another test's behavior. One test per behavior, at the level callers see it.

Before adding a test, look for one that already covers the behavior and extend it instead. Prefer one test that exercises a real flow over several that each poke at a piece. Never add production code only so a test can reach it.

Keep the tests that guard trust boundaries and hard invariants: Gate proofs, protected paths, never merging or speaking as the owner, the bounds on retries and escalations. Even then, one sharp test per invariant is enough.

No UI tests in this repo: no rendering, component-output, contrast or accessibility tests. The dashboard is checked by eye with screenshots. Only the UI HTTP server's security guards (token, Origin, remote-mode 403, audit-before-write, never merging) are tested, and those are server tests.

When you touch an area, delete tests there that break these rules. Cutting a useless test is a good change.

## Gate bundle: rebuild it when you change what it bundles

`bin/archangel-gate.mjs` is the Gate, bundled from `src/gate/**` and everything that imports into it (`src/config.ts` among others). When you change one of those files, run `bun run build:gate-bundle` and commit the rebuilt bundle in the same PR. `bun run check` (and CI) fails on a stale bundle; `bun run test:all` alone does not notice.

## UI changes: before and after screenshots in the PR

Follow `ui/DESIGN.md` for how pages should look.

For alignment or padding work on the dashboard, use the gridlines skill in `.claude/skills/gridlines`, with `ui/DESIGN.md` as the design policy it reads first.

A PR that changes how the dashboard looks (anything under `ui/`) shows before and after screenshots of every page it touches in its description, and is not merged without them. Shoot both from the same seeded data at the same viewport: before from the base commit, after from the PR head. Lay them out as a table, one row per page.

Images never go on main. Push them to the `pr-screenshots` branch under `<head-branch-name>/` and link them as `https://github.com/dgrah50/archangel/blob/pr-screenshots/<head-branch-name>/<file>?raw=true`.

## PR descriptions

Write for a reviewer who will skim. Same shape as the factory's Recap:

- **Summary first**, at most about 12 lines: Before / Now, what changed per area (one line each), decisions with their trade-offs where they apply, and how it was verified (facts, such as "new test red on base, green on head").
- **Details below**, in collapsed `<details>` sections with clear titles.
- Leave out: "CI passes", QA steps, how the work came to be, and internal IDs. Use plain words.
