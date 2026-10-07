# DESIGN: Later, built on the "Marginalia" design system

Tokens are the contract: `packages/design/` (tokens.css, base.css, fonts.css, icons.svg). Every surface
(web app, reader, extension popup, site) imports them. Do not hard-code a color, size, radius, duration or icon outside them.

## 1. Research findings (Oct 2026)
**Readwise Reader** is the power-user benchmark. It has single-key verbs (h highlights the focused paragraph,
n highlights it and opens a note, e archives, d deletes), `?`/Ctrl-K for the shortcut list, a paragraph focus cursor
driven by arrows and space, a triage feed (Inbox/Later/Archive), ghostreader AI and TTS. Its gaps: dense UI that tries
to do everything, onboarding that users call forced, a subscription-only model, and a highlight workflow split
between Reader and Readwise.
**Matter** is the taste benchmark. It has beautiful typography, gesture highlighting, HD text-to-speech and an excellent
parser (MacStories). Its gaps: Apple-first, highlights paywalled on the free tier, ~$60-80/yr, closed source, weak iPad/web.
**Instapaper** has a calm reading view, free unlimited highlights and good typography controls. It has aged:
dated IA, slow cadence and an unclear future.
**Omnivore** (shut down Nov 2024, after an acquisition and two weeks' notice) was open source and had labels,
highlights with notes, Logseq/Obsidian sync and read-aloud. Its lesson is that users lost libraries overnight,
so portability and self-hosting are the core trust feature.
**Pocket** (shut down and data deleted Oct 2025) was the default capture tool with simple tags. Commentary: "Pocket had a
hoarding problem, not a reading problem." The saved-to-read ratio was the real failure.
**iA Writer / iA "Responsive Typography"** argues that size follows reading distance, not taste: ~16px Georgia as a desktop baseline,
~140% line height on screen, and adaptive layouts (a few fixed measures) over fully liquid ones. Prefer dark grey on off-white to
pure black on white, and adjust optical size/grade as the size changes.
**Craft references.** Linear: instant optimistic UI, Cmd-K for every verb, the shortcut shown inside the menu item,
quiet chrome. Things 3: generous whitespace, one accent, delightful but brief motion, rich empty states.
Raycast: palette ergonomics (fuzzy matching, sections, the action shown on the right, Tab for secondary actions).
Arc: personality in small moments, never in the way. Stripe: typographic hierarchy, precise grids, docs as product.

## 2. Gaps we beat them on
1. **Never lose your library.** Self-hostable, open format, one-click full export (Markdown+JSON+EPUB) shown in the UI, not buried.
2. **Reading over hoarding.** The Inbox shows an honest queue ("12 articles · about 2h 40m"), a "Today" stack of 3, and auto-archive suggestions for stale saves. No guilt counters.
3. **Free highlights and notes everywhere**, with h/n paragraph highlighting like Reader but in calmer chrome like Matter.
4. **Keyboard-complete and palette-complete.** Every verb is reachable from Cmd-K, which shows its shortcut, and works offline.
5. **Typography that respects the reader.** Optical size, real old-style numerals, hanging punctuation, hyphenation, and three themes tuned as pairs. No paywall.
6. **Honest AI.** Summary and Ask always name their method ("extractive", or the model name) and link their sources; without a key, nothing breaks.

## 3. Identity: Marginalia
The concept is a reader's margin: warm paper, ink, and one proof-reader's red pencil. Calm, literate, precise. It must look
nothing like the default shadcn/Inter/indigo look and nothing like the user's other products: no gradients, glass or blobs.

### Type
| Role | Family (Fontsource) | Use |
|---|---|---|
| Reading serif | **Literata Variable** (opsz 7-72, wght 200-900, italics) | Article body, article titles, marketing display |
| UI sans | **Instrument Sans Variable** (wdth 75-100, wght 400-700) | Chrome, lists, buttons, labels; condensed wdth for dense meta |
| Mono | **JetBrains Mono Variable** | Code, keycaps, URLs, numbers in tables |

Literata was designed for long-form screen reading (Google Play Books), and its opsz axis lets one family serve body text and display titles.
Instrument Sans is a sharp, slightly narrow grotesk with a width axis and is clearly not Inter. Fallbacks are size-adjusted metric
fallbacks (`Literata Fallback`: Georgia with size-adjust; `Instrument Fallback`: Arial) to stop layout shift.
**Reading rules:** measure `66ch` (min 34ch on phones, max 72ch); body `clamp(1.0625rem, 0.96rem + 0.45vw, 1.3125rem)`;
line-height 1.62 for body, 1.15 for display; `hyphens:auto` with `hyphenate-limit-chars: 7 3 3`; `text-wrap: pretty` for body and
`balance` for headings; `hanging-punctuation: first allow-end last` (Safari) plus a `text-indent:-0.42em` fallback on quotes that open with
a quote mark; `font-feature-settings: "kern","liga","calt","onum","pnum"` in prose, and `"tnum","lnum"` in UI/tables;
`font-optical-sizing:auto`. The reader exposes size (5 steps), measure (narrow/normal/wide), leading (3 steps) and theme. Nothing else.
**Scale (UI, 1.2 minor third):** 12 / 13 / 14 / 15(base) / 17 / 20 / 24 / 29 / 35 / 42. **Prose scale (1.25):** h1 2.2em, h2 1.5em, h3 1.22em,
small 0.875em. Vertical rhythm: every prose block margin is `var(--rhythm)` (1 line), and headings get 2 lines above and 0.5 below.

### Palette (three themes, one accent)
| Token | Light "Paper" | Sepia "Vellum" | Dark "Ink" |
|---|---|---|---|
| --bg | #FBF9F4 | #F3EAD8 | #161513 |
| --surface | #FFFFFF | #F8F1E3 | #1D1C19 |
| --surface-2 | #F2EEE5 | #EADFC8 | #24221F |
| --ink | #1F1C17 (16.1:1) | #2E2618 (12.5:1) | #E9E4DA (14.4:1) |
| --ink-2 | #5E574C (6.8:1) | #62553F (6.1:1) | #A39C8F (6.7:1) |
| --ink-3 | #736A5C (5.1:1) | #695B43 (5.5:1) | #8E877B (5.1:1) |
| --accent "Vermilion" | #B23A1E (5.7:1) | #A3361B (5.7:1) | #F0805F (6.9:1) |
| --highlight (marker) | #F7E7A1 | #EED98A | #4A3F1C |
All text pairs pass WCAG AA (ratios against --bg). Highlight colors (yellow, green, blue, pink) are muted marker tones, used only for highlights.
Status colors: --ok #2F6B3F, --warn #8A5A00, --danger #A4262C (each brightened in dark). Absolutely no purple/blue gradients.

### Spacing, radius, elevation
Spacing is a 4px base: `--sp-0_5` 2, `--sp-1` 4, `--sp-2` 8, `--sp-3` 12, `--sp-4` 16, `--sp-5` 20, `--sp-6` 24, `--sp-8` 32, `--sp-10` 40, `--sp-12` 48, `--sp-16` 64, `--sp-24` 96.
Radius: `--r-xs` 3 (keycaps, tags), `--r-sm` 6 (inputs, buttons), `--r-md` 10 (cards, popovers), `--r-lg` 14 (dialogs, palette), `--r-pill` 999.
Elevation is paper-like: a hairline border carries most separation and shadows are warm and low. `--e-1` (row hover/raised), `--e-2` (popover/menu),
`--e-3` (palette/dialog). Dark mode replaces shadows with a lighter surface plus a 1px inner highlight.
Hairline: `--line` (1px, ink at 10%), `--line-strong` (ink at 18%).

### Motion
Motion is like a page settling, not bouncing. Easing: `--ease-out` cubic-bezier(.2,.8,.2,1) (enter), `--ease-in` (.4,0,1,1) (exit), `--ease-inout`
(.65,0,.35,1) (moves). Durations: `--d-1` 90ms (hover/press), `--d-2` 160ms (menus, toasts), `--d-3` 240ms (dialogs, panels), `--d-4` 360ms
(page/reader transitions). Exits are about 70% of enters. Animate only transform and opacity (60fps). Archive slides a row 8px and fades it out,
and the list closes the gap at d-3. Highlights "ink in" over 160ms. Under `prefers-reduced-motion: reduce`, all durations collapse to 0.01ms
except opacity fades (kept at d-1), and nothing moves or scrolls smoothly.

### Iconography
We draw our own sprite (`icons.svg`): 20x20 grid, 1.5px stroke, round caps and joins, `currentColor`, 2px live-area padding, no fills except
dots. Use `<svg class="icon"><use href="/icons.svg#i-archive"/></svg>`. Sizes are 16 (dense), 20 (default) and 24 (touch bars). Icons never appear
without a text label or an aria-label. No emoji in UI chrome or headings, and no sparkle icon for AI ("summary" is a paragraph-lines glyph).

## 4. Voice and tone
Write like a well-read friend: plain, warm, brief, exact. Use sentence case everywhere. Verbs on buttons. Numbers over adjectives. No hype.
| Do | Don't |
|---|---|
| "Saved. 7 min read." | "Awesome! Your article has been successfully saved!" |
| "Archived · Undo" | "Item moved to archive successfully." |
| "Nothing new. Save something with ⌘S in the extension, or paste a link." | "Your inbox is empty 🎉" |
| "Couldn't reach example.com. We'll retry when you're back online." | "Error: fetch failed (500)" |
| "Read anything later. Keep it forever." | "Supercharge your reading with AI" |
| "Export everything (Markdown, JSON, EPUB)" | "Unlock your data" |
| "Summary (extractive: 3 key sentences)" | "✨ AI magic summary" |
Errors name what happened, what we did, and what you can do. Never blame the user. Never invent social proof.

## 5. Components
- **Button**: primary (accent fill, used once per view), secondary (surface + line), quiet (text only), danger. Height 32 (dense) / 36 / 44 (touch).
  Press = translateY(1px) at d-1. A loading state keeps the width and swaps the label for a 3-dot ink pulse; no layout shift.
- **Input / search**: 36px, `--surface`, 1px `--line-strong`, focus = ring. A leading search icon and a trailing `/` keycap hint.
- **List row (article)**: title (UI sans 15/600, 2-line clamp), source favicon + domain + reading time + progress (ink-3, tnum), optional excerpt
  (serif 15, 2 lines) and thumbnail (64px, r-sm, right). The focused row gets a 2px accent bar on the left plus a surface-2 background. Hover actions
  (archive, star, more) fade in on the right, are always visible to keyboard focus, and form a swipe row on touch.
- **Toast**: bottom-left (bottom-center on phones), surface-inverse, max 1 visible with a stacked count. Undo action + keycap `Z`. 6s, paused on hover/focus.
  Every destructive or bulk action is optimistic and comes with an Undo toast; nothing destructive asks for confirmation except "Delete account".
- **Command palette (Cmd-K)**: 640px, r-lg, e-3, top 14vh. Sections: Actions, Go to, Tags, Articles (fuzzy). Each row shows icon · label · shortcut keycaps.
  Tab opens secondary actions, Esc closes. Recent commands come first, and it works on cached data offline.
- **Skeleton**: surface-2 blocks matching the final geometry with a 1.4s shimmer (static under reduced motion). Use skeletons only, never spinners for content.
- **Empty state**: left-aligned (not centered), a small line illustration from the icon set at 48px, a 1-line heading, 1-2 sentences, and one primary action plus one keyboard hint.
- **Focus ring**: 2px `--focus` (accent) outline with 2px offset, `:focus-visible` only. It appears on every interactive element and is never removed.
- **Scrollbars**: thin, `--ink` at 22% thumb on a transparent track; `scrollbar-gutter: stable` on scroll containers.
- **Keycap**: mono 11px, 1px line, r-xs, bottom border 2px.
- **Tag chip**: UI 12/500, surface-2, r-xs, with a hash-tinted 6px dot (from a fixed 8-tone muted set).
- **Highlight**: `background: linear-gradient(transparent 12%, var(--hl) 12% 88%, transparent 88%)` (a marker, not a box), plus a margin note dot.
- **Reader toolbar**: auto-hides on scroll down and returns on scroll up or mouse near the top. A progress hairline (accent) sits at the top edge.

## 6. Keyboard map (shown in ? help and in the palette)
| Key | Action | Key | Action |
|---|---|---|---|
| j / k | next / prev item (or paragraph in reader) | o / Enter | open |
| u / Esc | back to list | e | archive (toggle) |
| s | star / favorite | t | tag |
| h | highlight paragraph / selection | n | highlight + note |
| / | search | ⌘K / Ctrl-K | command palette |
| ? | shortcut help | d / # | delete (undo toast) |
| a | add URL | z / ⌘Z | undo last |
| l | listen (play/pause) | [ / ] | reader text size |
| g i / g a / g s / g h | go inbox / archive / starred / highlights | m | mark read/unread |
| x | select row (bulk) | shift+t | cycle theme |
| v | open original | . | more actions |
Single keys are disabled while typing in inputs. Every shortcut is remappable later, but the defaults never change meaning.

## 7. State catalogue (every surface implements all six)
- **First-run**: 3 steps inline in the Inbox (install extension or bookmarklet · import from Pocket/Omnivore/Instapaper · try a sample article we ship, clearly labelled as a sample). Each step can be skipped. No modal wizard.
- **Empty**: a per-view message (Inbox: "Nothing new…", Archive: "Archived articles live here. Press e on any article.", Highlights: "Select text and press h.").
- **Loading**: skeleton rows (6) / reader skeleton (title + 9 lines at the real measure). Anything under 150ms shows no skeleton (delay it).
- **Error**: inline and recoverable (Retry button and what failed). The whole-page error keeps navigation. Parser failures offer "Open original" and "Save as link".
- **Offline**: a quiet pill in the sidebar ("Offline · 214 articles available"). Writes queue with a count, and no error toasts appear for queued actions.
- **Success**: a toast that states the outcome, with Undo. There are no confetti or modals for routine actions.

## 8. Layout per surface (320px to ultrawide)
Breakpoints: `xs` <480, `sm` 480-767, `md` 768-1023, `lg` 1024-1439, `xl` 1440-1919, `2xl` ≥1920.
- **App shell**: xs/sm use a bottom tab bar (Inbox, Library, Search, More) with a 44px touch target and safe-area insets. md uses a collapsible 64px icon rail.
  lg+ uses a 232px sidebar. 2xl uses the sidebar plus the list (420px) plus a reader preview pane. Content never stretches past 1600px; ultrawide centres the shell and keeps the margins as paper.
- **List**: single column; the row's thumbnail is hidden below 400px and the excerpt is hidden below 360px. Gutter 16px on phones, 24px md, 32px lg.
- **Reader**: the column is `min(66ch, 100% - 2*gutter)` and centred. Margin notes sit in the right margin when the viewport is ≥ 66ch + 2*280px, and
  otherwise drop to inline cards. Images may break out to `min(100%, 66ch + 12rem)`; a figcaption is UI sans 13 ink-2. Top bar 48px.
- **Site**: 12-column grid, max 1200px, asymmetric hero (left text, right real screenshot). No 3-identical-card rows; feature sections alternate.
- **Extension popup**: 360x480, same tokens, dense scale.

## 9. Reader prose details
Blockquote: serif italic, 3px accent-tinted left rule at 30% opacity, indented 1.25em, `hanging-punctuation`. Pull quotes are not supported (scraped content).
Figure: centered, r-sm image, caption below in UI sans 13/ink-2, max-height 80vh, `object-fit: contain`.
Code: inline mono 0.88em on surface-2 with r-xs and 0.15em/0.35em padding. A pre block is full measure, scrolls horizontally, tab-size 2, 0.85em, line-height 1.55, and has no syntax rainbow
(ink-2 comments and an accent for strings only). Table: UI sans 0.9em, tnum, a hairline below each row and a strong line below the head, scrolls horizontally in a wrapper,
and has no zebra stripes. hr: three spaced dots (· · ·), centered. Lists: `::marker` ink-3, tnum. Links: ink with a 1px underline at 40% accent,
offset 0.18em, turning fully accent on hover. Footnotes: superscript in UI sans, `font-variant-position: super`. Drop cap: none.

## 10. QA bar
Screenshots at 375/768/1280/1920 × light/dark (+ sepia for the reader), judged against this file. Lighthouse ≥95 (site). Fonts: preload Literata
opsz woff2 latin only, `font-display: swap` with metric fallbacks, so CLS stays 0. Every surface: keyboard-only pass, VoiceOver pass and reduced-motion pass.
