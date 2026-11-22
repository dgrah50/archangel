# Implicit state machines and unenforced invariants

Look for behaviour that depends on a combination of booleans, nullable fields, flags, or call ordering that together encode a state:
- loading + error + data fields where "loading and errored" or "no data and not loading" is representable but meaningless
- "started" set but "finished" unset, or fields that must be reset together but are reset in separate places
- invariants the code relies on but nothing enforces: ordering, uniqueness, non-empty collections, idempotency, a value that must be set before another call

For each finding report:
1. **File & Symbol:** where the state lives, and the states the code actually distinguishes
2. **Illegal Combination:** the combination the types allow today that the logic cannot handle
3. **Verification:** a new test that drives the code into that combination on `main` and fails today

Do NOT propose rewriting to a state-machine library. Propose a closed union type or a single transition function only when a failing test justifies it.
