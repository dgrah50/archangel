# Working on Archangel

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
