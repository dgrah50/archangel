# Go strings and runes

Look for:
- byte indexing or slicing of strings that can hold multi-byte UTF-8 (cursor positions, truncation, column math)
- `len(s)` used where a rune or display-width count is needed
- off-by-one positions after trimming whitespace or splitting on a delimiter
