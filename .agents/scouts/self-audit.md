---
name: self-audit
schedule: daily
maxProposals: 2
includeMetrics: true
skills: [general/factory-signals, general/bug-hunt, general/error-handling, typescript/async-and-promises, typescript/type-holes]
---
Audit ONLY Archangel's non-kernel leaf modules (`src/core/doctor.ts`, `src/core/recap.ts`, `src/core/notifier.ts`, `src/core/logger.ts`, `src/core/studio.ts`, `src/handoff/paseo.ts`) for concrete, reproducible reliability or edge-case bugs.

IMPORTANT: Never propose changes to protected Trust Kernel paths (`src/config.ts`, `src/env.ts`, `src/gate/**`, `src/broker/**`, `src/agents/**`, `src/github/**`, `src/ledger/**`, `src/cli/**`, `src/core/blockers.ts`, `src/core/thread-machine.ts`, `src/core/reconciler.ts`, `src/core/scout.ts`, `templates/**`, `workflows/**`, `bin/**`).

Only propose an issue if you can provide:
1. **File & Symbol:** exact leaf file path and function/method name
2. **Problem:** concrete bug, crash, or broken edge case (no style nits or speculative refactors)
3. **Expected Behavior:** exact fix requirement strictly within leaf modules
4. **Verification:** a concrete new Vitest test under `test/` (do not edit existing tests) that compiles against `main` and fails today
