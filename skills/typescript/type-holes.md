# TypeScript type holes

Look for runtime values the types claim cannot happen:
- `as` casts, non-null `!` assertions, or `any` hiding `undefined`/`null`
- `JSON.parse` or external input used without validation
- exhaustive `switch` statements missing a case the union allows
- array index access assumed to be defined
