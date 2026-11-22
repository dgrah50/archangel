# UI state and rendering

Look for:
- state derived from props or inputs that goes stale after they change
- mutation of shared objects (theme tokens, config, default props) instead of copies
- colour, contrast, or layout calculations that break at boundaries (hue wrap at 0/360, empty lists, very long text)
- keyboard and focus handling that leaves focus lost or trapped

A reproduction must be a test that fails on `main` today, not a visual opinion.
