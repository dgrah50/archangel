# Dashboard design rules

The owner's rulings from the dashboard redesign rounds. Read this before changing how any page looks; reviewers check UI diffs against it.

## Where the look comes from

- Theme and provider: vendored from the owner's design system (Arc for Chakra), see `src/theme/SOURCE.md`. Use its tokens and components; do not invent colours, radii or shadows.
- Component inspiration: https://uiarc.dev for cards, charts and stat tiles. Prefer its patterns over hand-rolled boxes.
- Reference designs: the owner's Paper file "Arc × Chakra theme", page "Archangel dashboard", and PNG exports in the gitignored `designs/` folder of the owner's checkout.

## Rules

- **Every element on the Overview is actionable or informative at a glance.** If the owner cannot tell what a number means or what they would do about it, cut it (a vague "autonomous steps 22/25" was cut for this reason). Keep the money: spend per PR and spend today.
- **Dense, not busy.** One clear reading order. When a page feels overloaded, strip content before restyling it; reach for a chart over a wall of numbers.
- **Page headers are a plain title with the counts beside it in grey** ("Threads 17"). No tagline sentences, no highlighted words inside headlines, no explanatory sub-sentence under the title. A sentence that states a rule needed at the moment of acting goes next to the control it governs.
- **Overview keeps one status line** because there it is the data: plain ink, no accent colour ("3 decisions and 2 pitches waiting", or "Nothing is waiting on you").
- **Accent colour marks one thing once.** If the nav badge already flags it, the row and the heading do not repeat it.
- **No AI-slop tells:** gradient or highlighted text, decorative emoji, clever copy in place of labels, cards nested in cards, uniform rounded boxes for everything.
- **Plain words.** Use the names the nav and the rest of the product use; no internal IDs or jargon the owner has to ask about.
