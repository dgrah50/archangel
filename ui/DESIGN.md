# Dashboard design rules

How the dashboard should look and how it is put together. The Rules are the owner's rulings from the redesign rounds; the rest records what those rounds built. Read this before changing how any page looks; reviewers check UI diffs against it. When a change makes part of this untrue, update it in the same PR.

## Where the look comes from

- Theme and provider: vendored from the owner's design system (Arc for Chakra), see `src/theme/SOURCE.md`. Use its tokens and components; do not invent colours, radii or shadows.
- Components: real Arc components from https://uiarc.dev, copied into `src/arc/` (see "How the dashboard is built"). Use one before hand-rolling a box.
- Reference designs: the owner's Paper file "Arc × Chakra theme", page "Archangel dashboard", and PNG exports in the gitignored `designs/` folder of the owner's checkout.

## Rules

- **Every element on the Overview is actionable or informative at a glance.** If the owner cannot tell what a number means or what they would do about it, cut it (a vague "autonomous steps 22/25" was cut for this reason). Keep the money: spend per PR and spend today.
- **Dense, not busy.** One clear reading order. When a page feels overloaded, strip content before restyling it; reach for a chart over a wall of numbers.
- **Page headers are a plain title with the counts beside it in grey** ("Threads 17"). No tagline sentences, no highlighted words inside headlines, no explanatory sub-sentence under the title. A sentence that states a rule needed at the moment of acting goes next to the control it governs. A page's control (repo switcher, tabs, buttons) goes in `PageHeadline`'s `right`, so the title sits at the same height on every page. A page that is shown inside another (Settings, Per repo) has only the outer title.
- **Overview shows its counts as badges beside the title** because there they are the data: need you, stuck, running, landed today, or "nothing needs you". They are counts, never a sentence.
- **Accent colour marks one thing once.** If the nav badge already flags it, the row and the heading do not repeat it in amber text or fills. A status dot is not an accent: it is how a row says what state it is in.
- **No AI-slop tells:** gradient or highlighted text, decorative emoji, clever copy in place of labels, cards nested in cards, uniform rounded boxes for everything.
- **Plain words.** Use the names the nav and the rest of the product use; no internal IDs or jargon the owner has to ask about.

## How the dashboard is built

Three layers, in the order to reach for them:

1. **Arc components** in `src/arc/`. Real components from https://uiarc.dev (free tier, MIT), copied from its registry. They read Arc's CSS variables, which `src/theme/arc-bridge.ts` aliases to the Chakra theme, so they follow light and dark and the theme's tokens with no extra stylesheet. `src/arc/SOURCE.md` lists what is copied and every local edit.
2. **Page primitives** in `src/page.tsx`: `Page`, `PageHeadline`, `Section`, `RowList`, `Row`, `MasterDetail`, `PickRow`, `Group`, `Line`, `Dot`, `Issues`, `CopyCommand`, `LinkButton`, `Ref`, `Ticked`. `src/thread-lines.tsx` holds the Thread list shared by the Overview and Threads (`ThreadLine`, `PrBadge`, the running group).
3. **Chakra with the Arc theme** for everything else (buttons, inputs, selects, switches, checkboxes). Its recipes are a port of Arc, so these already match.

Before hand-building a control, check that list of Arc components first. A hand-built chart, meter, tab strip, copy button, timeline, stepper, alert or empty state is a regression.

### What each Arc component is used for

| Component | Where |
| --- | --- |
| `bar-chart` | Overview: fixes landed per day |
| `sparkline` | Overview: cost per merged fix |
| `usage-meter` | Overview: today's metered spend against the daily cap |
| `badge` | Overview: the counts beside the title, account status. Every state word: check results (Passed, Failing, Warning), setup tags (Needs you, Next step), PR links, decision class, pitch type and size, Gate passed, eval verdicts |
| `skeleton` | Every main loading state (pages, the open Thread, recap, reports) |
| `segmented-control` | The repo and scope switchers on Threads, Pipeline and Settings |
| `copy-button` | Every command to copy (`CopyCommand`), transcript paths |
| `timeline` | A Thread's audit events |
| `stepper` | A Thread's phase |
| `alert` | Every banner, halt and problem notice |
| `empty-state` | Threads with nothing selected |

### Adding an Arc component

- Take it from `https://uiarc.dev/r/<name>.json` (the index is `https://uiarc.dev/llms.txt`). Copy its files into `src/arc/<name>/`, and shared files into `src/arc/lib/`.
- Free components only. Pro components need a licence the repo does not hold.
- Prefer components whose only dependencies are `motion` and `lucide-react`, which are installed. A component that needs a Radix package is worth it only when Chakra's themed equivalent will not do.
- Do not restyle a copied component. If it must change, make the smallest edit and record it in `src/arc/SOURCE.md`.
- Add the name to `SOURCE.md` and to the table above.

## Surfaces

- **One card style.** Panel fill, a hairline border, the surface radius, no shadow: `Section` in `page.tsx`, or `bg="bg.panel" borderWidth="1px" borderColor="border" rounded="surface"`.
- **Cards never nest.** A section inside a card is `<Section inner>`: a hairline above it, no second box.
- **Rows inside a card** are separated by hairlines (`RowList`), not by their own boxes.
- **Group bands** (the Overview's "Needs you", "Running" …) are a filled strip that folds, not a card (`Group`). The Threads page uses the same bands, names, order and dots; Queued and Landed fold there.
- **Selectable lists** (Needs you, Pitches, Threads, Setup steps) are one pattern: rows on the bare surface (`PickRow`, or `Line` for one-line Threads), a 10px radius, a lighter fill on hover, a hairline outline and a filled background on the selected row. No dividers between rows, no amber on the selected row. Needs you, Threads and Pitches put the list left and the detail right in `MasterDetail`, edge to edge under the title.
- Master and detail pages keep the list on the bare surface and put the detail's blocks in cards.
- **State words are badges** (`Badge`), not coloured text: green only for passed or healthy, amber (`warning`) only when the owner has to act, grey for everything else.

## Colour

Colour carries meaning; decoration is ink and grey.

- **Amber (`owner`)**: only the owner can move this, or the factory has stopped or is about to. Alerts for these use the `warning` tone.
- **Violet (`unsent`)**: an edit that is not saved yet (outline on the field, the new account's name).
- **Green (`passed`)**: a passed check or a healthy state, always next to a word that says so.
- **Red**: a failed event in the Thread timeline (Arc's `danger`). Nothing else.
- Charts are ink. Do not give series colours a meaning the page does not explain.

`Dot` tones: `owner`, `ink` (the factory is acting), `ring` (waiting, not blocked), `hollow` (idle or queued), `passed`.

## Type

Use the text styles in `src/theme/motion.ts`; do not set font sizes inline.

- `headline` the page title; `title` a detail pane's title; `figure` a number that leads a row or panel.
- `label` a row's title or a control's name; `body13` body copy; `meta` secondary copy; `caption` the smallest notes.
- `ref` and `command` are mono: issue references, account ids, commands.

## Pages

- **Overview**: title with counts as badges; three cards (landed per day, Threads at each station with cost per fix, spend with verdict agreement); the Accounts card (one line per login: status, a bar for its tightest limit window, every window as "5 h 22% · week 13%", when the tightest resets, how old the reading is; the same words sit under the account in Settings); then every Thread on one line, in folding groups ordered by what it is waiting for.
- **Needs you**: the queue on the left, oldest first; the selected decision on the right as cards (recommendation, recap, blockers), then the actions.
- **Threads**: Threads grouped like the Overview on the left (a row is the title and its ref); the selected Thread on the right: phase stepper, timeline, Gate proof.
- **Pipeline**: one repo's line as rows in a card; the repo switcher top right.
- **Pitches**: open pitches on the left; the selected pitch as one card with inner sections.
- **Settings**: one card of blocks (Models, Accounts, Limits, Repos, Alerts); the unsaved-changes card on the right.
- **Setup and health**: steps (selectable list) on the left, the selected step's checks on the right; Faults, Telemetry and Evals as cards below.

## Behaviour that shapes the design

- **The dashboard never acts on GitHub or the daemon.** It links out, or gives a command to copy. Do not add a button that merges, restarts or replies.
- **Edits are drafts.** A change to `archangel.yaml` or a workflow is held as unsaved (violet), summarised in the side card, previewed against the server's validation, then saved. A new control that writes config goes through the same flow; it never writes directly.
- **Empty and missing values are grey**, never a zero or a dash that looks like data: "n/a", "none", "not recorded".
- **Absent beats empty.** A block with nothing abnormal to say (what stops work next, an Accounts card in remote mode) is not rendered.
- **Layout holds at 900 px.** Card rows stack; one-line rows truncate the grey context before the title.

## Checking a change

- No UI tests in this repo. Check by eye, in light and dark, at 1440 and 900 px, on a busy seed and a quiet one.
- Click anything you changed that switches state, and read the browser console for errors.
- Screenshots in a PR are public. Seed them; never shoot a page that shows a real path, account reading or repo name from the owner's machine.
- The PR carries before and after screenshots (see AGENTS.md).
