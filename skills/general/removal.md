# Removal and duplication

Look for code that costs more than it earns:
- dead code: exports, options, branches and files nothing calls or sets (name the grep that shows no caller)
- duplication: two or more near-identical implementations that must change together
- single-caller abstractions: a helper, wrapper or layer used once that adds indirection and no behaviour
- redundant tests: tests that restate the code or duplicate another test's behaviour

Every finding names the files and symbols, the count (callers, copies, lines) and what deleting or merging it removes. Prefer deleting over refactoring. Do not propose changes that alter behaviour.
