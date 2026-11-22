# Error handling

Look for errors that are lost or turned into wrong results:
- errors caught and ignored, or logged and then execution continues with partial state
- cleanup (close, unlock, rollback) skipped on an early return or thrown error
- a failed operation reported as success (wrong exit code, `ok: true`, empty result instead of an error)
- retries that repeat a non-idempotent side effect

Only report a case where a new test can trigger the failure on `main` today.
