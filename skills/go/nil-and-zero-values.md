# Go nil and zero values

Look for:
- nil maps written to after `json.Unmarshal` of `null` or a missing field
- nil pointer, interface, or slice dereferences on error paths
- zero-value structs used as if constructed (missing defaults, unset mutexes copied by value)
- `err` shadowed inside an `if` so the outer error is never checked
