Vendored from the design-system repo (dgrah50/design-system) at commit 638b6914e111c418e7bbcfbe2ac209686d0a84d0:
`src/theme/` and `src/provider.tsx` (one directory up). That repo is a private app, not a published package, and its README
documents consuming it by copying `src/theme/`. To update, re-copy from a newer commit and bump the hash here.

Local change: `ui/src/provider.tsx` uses next-themes `defaultTheme="system"` with `enableSystem` so the dashboard follows prefers-color-scheme.
