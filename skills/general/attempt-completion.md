# Finish an Attempt cleanly

An Attempt fails when it ends without a committed, buildable change that addresses the issue. Before ending, prove the Attempt is complete.

## Detection heuristic

Treat the Attempt as at risk when any of these hold:

- The plan touches more files or symbols than can be verified in one pass (scope too wide for one Attempt).
- The change relies on a command, path, symbol or API you have not opened or run in this checkout.
- `git status` shows uncommitted or untracked work, or `git diff main...HEAD` is empty.
- The repo's typecheck, lint or the tests nearest the change have not been run after the final edit.
- The issue's expected behavior is not covered by a test or reproduction that fails before and passes after.

## What to do

1. Narrow to the smallest change that fixes the stated problem; defer the rest.
2. Read each symbol you call or edit before writing against it.
3. Run the typecheck and the closest tests after the last edit; fix failures instead of reporting them.
4. Commit the work and confirm the branch has at least one new commit versus its base.

## Anti-pattern
