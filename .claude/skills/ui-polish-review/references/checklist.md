# Polish checklist (give this to the reviewer verbatim)

Look at each screenshot as a first-time user would, then at the details. Report only what you can see.

1. **Clipping and cut-offs**: text, buttons, borders, shadows, focus rings or beams cut by a container edge; bars that run under a sidebar; content hidden by a fixed bar.
2. **Overlap**: elements drawn over text or each other (icons over labels, badges over titles, knobs against track edges).
3. **Doubles**: two icons, two spinners/orbs, two borders or two focus indicators where one is meant.
4. **Alignment and rhythm**: inconsistent padding/margins between similar blocks; controls of the same kind with different heights, widths or radii; baselines that do not line up; a row whose actions sit beside the text while its siblings put them below.
5. **Scrolling**: nested scrollbars, scrollbars that overlap content or cut the rounded corners, horizontal scroll.
6. **Wrapping**: labels, buttons, chips or tabs that wrap to two lines or squeeze; orphan single words.
7. **Contrast and legibility**: muted text on tinted/glass backgrounds, text over busy backgrounds, disabled states that look broken rather than disabled, dark-theme specific problems.
8. **Consistency across surfaces**: the same thing (segmented control, switch, primary button, chip, header, footer, empty state) must look the same everywhere; wording for the same action must match.
9. **States**: empty, loading, error and success states look designed, not like leftovers (raw "undefined", unstyled links, default browser controls).
10. **Hierarchy and flow**: one obvious primary action per screen; destructive actions visually quieter and confirmed; order of elements follows the order of the task.
11. **Details**: radii nest properly (inner radius = outer radius minus padding), icons share a stroke weight, no 1px misalignments, focus ring visible on the focused control and not doubled.
