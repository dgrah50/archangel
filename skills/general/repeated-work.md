# Repeated unnecessary work

Look for work done more often than needed:
- recomputation, re-parsing, or re-reading inside a loop or on every call when the result cannot change
- whole-collection or whole-window processing where only the visible or changed part is needed
- repeated allocation or copying of large values on a hot path

Every finding must include a measurement or concrete count (for example "parses the file N times for N lines", or a call count for M items), not a guess about speed.
It must also be reproducible: a new test (or benchmark-style check with a fixed threshold, such as a call counter that exceeds one per item) that fails on `main` today. Do NOT propose speculative optimizations, caching layers, or micro-optimizations without such a check.

For each finding provide the file and symbol, the observed count or timing, and the verification test.
