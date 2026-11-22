Audit ONLY Archangel's non-kernel leaf modules, the files listed in `.agents/leaf-modules.json` (`src/core/digest.ts`, `src/core/logger.ts`, `src/core/recap.ts`, `src/core/status-text.ts`, `src/core/studio.ts`, `src/core/ui-state.ts`, `src/mastra/index.ts`) for concrete, reproducible reliability or edge-case bugs.

IMPORTANT: Never propose changes to any file outside that leaf list. Everything else in this repo is the protected Trust Kernel (`gate.protectedPaths` in `.agents/archangel.json`, plus `.agents/**` and `.github/**`), and only the owner changes it.

Only propose an issue if you can provide:
1. **File & Symbol:** exact leaf file path and function/method name
2. **Problem:** concrete bug, crash, or broken edge case (no style nits or speculative refactors)
3. **Expected Behavior:** exact fix requirement strictly within leaf modules
4. **Verification:** a concrete new Vitest test under `test/` (do not edit existing tests) that compiles against `main` and fails today
