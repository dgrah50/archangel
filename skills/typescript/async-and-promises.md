# TypeScript async and promises

Look for:
- promises that are not awaited, so errors are unhandled or ordering is wrong
- races between concurrent async calls updating the same state
- `try/catch` that does not cover the awaited call it was meant to guard
- timers, listeners, or subscriptions never cleared
