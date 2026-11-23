Arc components (https://uiarc.dev), free tier, MIT. Copied from the public registry (`https://uiarc.dev/r/<name>.json`) on 2026-11-22:
`bar-chart`, `sparkline`, `usage-meter`, `badge`, and `lib/motion-tokens.ts` (the registry's `motion-tokens.ts`).

They read Arc's CSS custom properties, which `ui/src/theme/arc-bridge.ts` aliases to the Chakra theme, so `foundation.css` is not installed.
To update one, re-copy its files from the registry.

Local change: `bar-chart.tsx` no longer rounds the average to a whole number (our daily counts are small, so "1" for 1.1 misleads).

Added the same way: `segmented-control`, `copy-button` (with `lib/use-copy-feedback.ts`), `timeline`, `empty-state`.
Also added: `alert`, `stepper`.
