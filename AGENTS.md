# Design Language

Build clean, responsive interfaces with deliberate typography, accessible focus states, and purposeful motion. Preserve the approved Hydramist KOTH arena concept.

## UI Gotchas

- Inputs use at least 16px text on iOS.
- Use `touch-action: manipulation` on controls.
- Use tabular numerals for scores.
- Honor `prefers-reduced-motion`.
- Animate only transform and opacity.
- Never use `transition: all`.
