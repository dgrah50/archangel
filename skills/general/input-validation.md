# Input validation and boundaries

Look for inputs the code accepts but handles wrongly:
- empty, whitespace-only, zero, negative, or maximum-size values
- unicode, multi-byte characters, and mixed line endings
- duplicate keys, unsorted input, or input that is already in the target state
- partial validation where an early element is mutated before a later element is rejected

Only report a case where a new test can trigger the failure on `main` today.
