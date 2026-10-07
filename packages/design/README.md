# @later/design: Marginalia

Marginalia is the design system for Later. Think of warm paper and ink, with one proof-reader's red pencil as the accent.
The full rationale (research, voice, components, keyboard map, states and layouts) is in `.orch/DESIGN.md`.

## Use

```css
@import "@later/design/fonts.css";   /* Literata, Instrument Sans, JetBrains Mono (variable) */
@import "@later/design/tokens.css";  /* custom properties + themes */
@import "@later/design/base.css";    /* reset, focus, scrollbars, selection, .prose, .icon, kbd, .skeleton */
```

- **Themes**: set `data-theme="light" | "sepia" | "dark"` on `<html>`. Without it, `prefers-color-scheme` picks light or dark.
- **Motion**: honours `prefers-reduced-motion`. Set `data-motion="reduce"` on `<html>` to force it from settings.
- **Prose**: wrap article HTML in `<article class="prose">`. You can set `data-size="-2..2"`, `data-measure="narrow|wide"`
  and `data-leading="tight|loose"` on it.
- **Icons**: serve `icons.svg` statically and use `<svg class="icon" aria-hidden="true"><use href="/icons.svg#i-archive"/></svg>`.
  Use `.icon--sm` (16) or `.icon--lg` (24) to change the size. Every icon-only button needs an `aria-label`.

## Token groups

| Group | Examples |
|---|---|
| Color | `--bg --surface --surface-2 --ink --ink-2 --ink-3 --line --accent --on-accent --focus --hl-*` |
| Type | `--font-serif --font-sans --font-mono --fs-2xs…--fs-display --lh-* --prose-*` |
| Space | `--sp-0…--sp-24`, `--gutter`, `--control-h*` |
| Shape | `--r-xs --r-sm --r-md --r-lg --r-pill`, `--e-1…--e-3` |
| Motion | `--ease-out --ease-in --ease-inout --d-1…--d-4` |

## Icons (`#i-…`)
inbox, archive, star, star-fill, tag, search, highlight, note, listen, play, pause, send, download, import, export,
settings, plus, close, check, undo, chevron-left/right/up/down, link, external, feed, mail, summary, ask, offline,
sun, moon, sepia, type, more, trash, refresh, keyboard, command, book, clock, menu, alert.

## Rules
- Use the tokens and nothing else: no raw hex values, px font sizes or ad-hoc durations in app code.
- Use one accent-filled button per view. Highlights use the `--hl-*` colors only.
- Animate only transform and opacity, and never move anything under reduced motion.
- Fonts are OFL-1.1 (Fontsource). Icons are original, MIT like the rest of the repo.
