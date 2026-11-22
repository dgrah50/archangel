---
name: test-gaps
schedule: manual
maxProposals: 2
---
Inspect core business-logic modules and identify untested edge cases where current behavior is actually wrong or fails to handle boundary inputs cleanly.

Only propose an issue if there is a real behavioral bug or missing edge-case guard that a new test will fail on against `main` today (never propose pure test-only additions that already pass on `main`).
For each finding, state the exact file, symbol, broken edge case, expected behavior, and concrete failing-test verification.
