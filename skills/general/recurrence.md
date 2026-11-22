# Recurrence

Look for a defect that has already been fixed once and is still present:
- a symptom that came back after an earlier fix (read recent fix commits and the tests they added, then check whether the same failure mode still exists on `main`);
- the same defect in sibling callers or sibling code paths of a function that was fixed (find every other caller or twin implementation and check each one).

Do NOT propose a new class of bug, a refactor, or a general cleanup. Propose exactly one boundary fix.
For each finding, provide:
1. **File & Symbol:** the still-broken caller or path
2. **Earlier Fix:** the commit or function that was fixed, and what it fixed
3. **Problem:** why the same defect remains here
4. **Verification:** a concrete new boundary test (do not edit existing tests) that compiles against `main` and fails today
