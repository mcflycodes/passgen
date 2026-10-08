# PassGen styles

A style is the look of the page: colours, corners, type, spacing and an
optional decorative background. Every style shares one markup and one layout
stylesheet (`src/styles.css`) and differs only in design tokens, so a new
style never needs layout or feature work (requirement R4a). Anyone can make
one; the build checks it (R4b).

## Files

```
src/styles/<id>/style.css   the style: tokens under :root[data-style="<id>"]
src/config/config.json      style.default and style.offered (C1)
```

`<id>` is lowercase letters, digits and hyphens, and is also the value of
`data-style` on `<html>`. To offer a style, add `{ "id": "<id>", "label":
"<Name>" }` to `style.offered`; to make it the default, set `style.default`.
With one offered style the Style control is left out of the page. The build
fails if the default is not offered or an offered style has no stylesheet.

A style may credit its human author in a comment. It may not carry a credit
to a tool, model or vendor; the attribution check refuses that.

## The one stylesheet

A style is tokens only. The file holds `:root[data-style="<id>"] { … }`
rules (one, or several) whose declarations are all custom properties
(`--*`), and nothing else. All real styling lives in the shared layout
stylesheet, `src/styles.css`, which reads the tokens; a look that needs a
new knob gets a new optional token there, never a rule in the style. The
build judges the file as the CSS parser reads it, with escapes decoded, and
judges it again as the minifier re-serialises it, so there is no spelling
of a rule that slips past it:

- Only custom-property declarations, only in top-level rules whose selector
  is exactly `:root[data-style="<id>"]`. No ordinary property (not even
  `color` or `-webkit-text-fill-color`), no other selector, no selector
  list, no descendant or compound selector, no nesting.
- No at-rule at all: no `@media`, `@supports`, `@container`, `@import`,
  `@font-face`, `@namespace`, `@keyframes`, `@property`, `@layer`, … Light
  and dark are expressed with `light-dark()` pairs; the page sets
  `color-scheme` from the theme (System follows the operating system).
- No external resource of any kind, in any token value or `var()` fallback.
  A style is tokens plus CSS gradients (R4c): no `url()`, `image-set()`,
  `image()`, `cross-fade()`, `element()`, `paint()`, `src()`, and no form of
  them that only becomes one once comments are dropped (`u/**/rl(…)`) or
  escapes are decoded.
- No `!important`.
- Colours are `light-dark(light, dark)` pairs, or one value for both themes,
  written as hex, `rgb()`, `rgba()`, `transparent`, or `var()` of another
  colour token (without a fallback). A colour token, and every token it
  reaches through `var()`, is declared exactly once. The build follows every
  chain and refuses one it cannot resolve.

The emitted CSS of the whole build is checked again by `pnpm verify:dist`:
it may load no resource either.

## Token types

Every token has a type, and the build refuses a value of any other shape
(`scripts/lib/style-grammar.ts` is the one list). A token not in this table
is refused too. Bounds are in px unless stated.

| Type | What it accepts |
|---|---|
| opaque colour | hex, `rgb()`, `rgba()` with alpha 1, `white`, `black`, a `light-dark()` pair of those, or `var()` of another colour token; never transparent or translucent, because the layout paints text on it |
| colour | the same, alpha allowed; the contrast check composites it over the surface it sits on |
| length | px (or `0`) within the stated bounds; `--pad` may also be `clamp(<px>, <vw up to 10>, <px>)` |
| radius | 0 to 1000px, 0 to 4em, or 0% to 50% |
| tracking | `0`, -0.2em to 0.5em, or -4px to 8px; `--tagline-track` may be `var(--label-track)` or `var(--track)` |
| number | a plain number within the stated bounds |
| keyword | one of the listed identifiers |
| shadow | `none`, or a list of outer shadows `<x> <y> [<blur> [<spread>]] <colour literal>`: offsets within 24px, blur 0 to 64px, spread -32px to 24px, no `inset`, never `var()` |
| gradients | `none`, or at most 3 layers of `linear-gradient()`, `radial-gradient()`, `conic-gradient()` and their `repeating-` forms, each with 1 to 8 literal colour stops, geometry words, lengths, angles and percentages; only `var(--pxs)`, `var(--pys)`, `var(--pxt)`, `var(--pyt)`, `var(--pxn)`, `var(--pyn)` (and the raw `--px`, `--py`) may appear, also inside `calc()`, `min()`, `max()` and `clamp()`. More layers or stops are refused, never cut |
| font stack | 1 to 12 family names, identifiers or one quoted string each; `--tagline-font` may be `var(--sans)` or `var(--mono)` |
| border | `0`, `none`, `var(--hairline)`, or `<length up to 4px> solid <colour literal, var(--line) or var(--line-strong)>` |
| size | `auto`, or one or two lengths from 1px to 512px or percentages |

## Required tokens

| Group | Token | Type |
|---|---|---|
| Surfaces | `--bg` page, `--panel` cards, `--field` inputs and result boxes, `--chip` small Copy buttons | opaque colour |
| | `--bg-band` intro band | colour (may be transparent; the intro text is checked against it composited over the page gradients) |
| Lines | `--line` decorative hairlines, `--line-strong` control borders (3:1), `--grid-line` intro grid, `--intro-glow` intro gradient colour | colour |
| Text | `--text`, `--text-2` secondary, `--muted` labels and hints (4.5:1 on their surfaces) | colour |
| Accent and states | `--accent` buttons, checks, slider; `--on-accent` text on the accent (4.5:1); `--focus` focus ring (3:1); `--bad`, `--warn`, `--ok` | colour |
| Shape | `--radius` cards, `--radius-sm` controls, `--thumb-radius` slider thumb | radius |
| | `--shadow` card shadow | shadow |
| | `--band-border` under the intro | border |
| | `--band-gap` between bands, `--panel-gap` between the cards (negative overlaps hairlines; 0 collapses the cards into one frame) | length -8 to 64 |
| Type | `--sans`, `--mono` | font stack |
| | `--track` display letter-spacing, `--label-track` eyebrow letter-spacing | tracking |
| | `--display-weight` | number 100 to 1000 |
| Spacing | `--pad` card padding | length 0 to 64 |
| | `--row-gap` control rows | length 0 to 48 |
| | `--control-h` control height | length 24 to 64 |
| | `--header-h` | length 40 to 120 |

## Optional tokens

| Token | Type | Default | What it does |
|---|---|---|---|
| `--result-radius` | radius | `var(--radius-sm)` | Corner radius of the two result boxes. |
| `--gap-no-intro` | length -8 to 64 | `clamp(24px, 3vw, 40px)` | Space between the header and the cards when the intro is off. |
| `--tagline-font` | font stack | `var(--sans)` | The header tagline's family; its colour is always `--muted`. |
| `--tagline-size` | length 10 to 20 | `13px` | The tagline's size. |
| `--tagline-case` | keyword `none`, `uppercase`, `lowercase`, `capitalize` | `none` | The tagline's case. |
| `--tagline-track` | tracking | `0` | The tagline's letter-spacing. |
| `--meter-1` … `--meter-6` | colour | `--bad`, `--bad`, `--warn`, `--ok`, `--ok`, `--ok` | The six-step strength ramp; each must clear 3:1 against `--panel`. |

### Decorative background (R4c)

One layer behind all content, from tokens only. Panels, result boxes and
controls keep solid surfaces. The only text over the background is the
intro's and the header's, and the build checks both against every colour
the gradients can place there.

| Token | Type | Default | What it does |
|---|---|---|---|
| `--fx-static` | gradients | `none` | Gradient layer(s) always drawn. |
| `--fx-size` | size | `auto` | `background-size` of the static layer, for tiled patterns. |
| `--fx-attach` | keyword `fixed`, `scroll` | `fixed` | `background-attachment` of the static layer. |
| `--fx-pointer` | gradients | `none` | Gradient layer(s) placed by the pointer through the pointer variables. |
| `--fx-follow` | number 0 to 1 | `0` | `1` opts into the pointer script (`src/ui/pointer.ts`), which only writes the pointer variables on the root and holds them to 0..1. |
| `--fx-rest-x`, `--fx-rest-y` | number 0 to 1 | `0.5`, `0.3` | Resting pointer position. |

## Contrast pairs the build checks

Both themes, WCAG 2.2 AA. Translucent colours are composited over `--bg`
first.

- 4.5:1 (text): `--text` on `--bg`, `--panel`, `--field`, `--chip` and the
  intro background; `--text-2` on `--bg`, `--panel`, `--field` and the intro
  background; `--muted` on `--bg`, `--panel`, `--field`; `--on-accent` on
  `--accent` and on `--ok`; `--bad` and `--warn` on `--panel`; `--text`,
  `--text-2` and `--muted` on the header. The intro background is every
  combination of `--bg-band`, `--intro-glow` and `--grid-line` over every
  gradient stop of `--fx-pointer` over `--fx-static` over `--bg`; the header
  is `--bg` at 90% over any of those or over `--panel`.
- 3:1 (controls): `--accent`, `--line-strong` and `--focus` on `--bg`,
  `--panel`, `--field`; `--ok` and each declared `--meter-N` on `--panel`.
- The footer: `--text-2` on the page with its decorative layers.

### How the page background is bounded

Three text regions sit on the page itself rather than on a panel: the intro
(over `--bg-band`, then its grid lines, then its glow), the header (over
`--bg` at 90%) and the footer (directly). Behind all of them the layout
paints `--bg`, then the `--fx-static` layers, then the `--fx-pointer` layers,
first listed on top. The build bounds every pixel those layers can produce
with interval arithmetic, and the bound is conservative by construction:

1. Browsers interpolate a gradient between two stops in premultiplied
   encoded sRGB: each premultiplied channel (channel × alpha) and the alpha
   itself is linear in the position, so between two stops it lies between
   its values at those stops. Over all of a layer's stops, the per-channel
   minimum and maximum of the premultiplied colour and of the alpha form a
   box that contains every colour the layer can show anywhere.
2. Source-over compositing is `C = p + (1 − a) × B` per channel, with `p`
   the premultiplied source, `a` its alpha and `B` the opaque backdrop. With
   `p ∈ [pLo, pHi]`, `a ∈ [aLo, aHi]` and `B ∈ [bLo, bHi]`, every result lies
   in `[pLo + (1 − aHi) × bLo, pHi + (1 − aLo) × bHi]`. The layers are
   composited as boxes in paint order over `--bg`, then the band, glow, grid
   or header tint over that. Where the pointer layer sits changes which
   colour lands where, never which colours it can show, so one box covers
   every pointer position.
3. WCAG relative luminance rises with each channel, so the luminance of
   every pixel in a box lies between the luminance of the box's lower and
   upper corners. Text drawn over a pixel keeps that ordering. If the text's
   luminance range and the background's overlap, the bound cannot establish
   any separation between them, so the contrast is taken as 1:1 and the
   style is refused; otherwise the lowest contrast the bound allows is
   between the two nearest ends. The build requires 4.5:1 against that.

The checker models exactly the tokens the layout paints where text can sit
(`PAINTED_TOKENS` in `scripts/lib/style-checks.ts`); a unit test
cross-checks that list against `src/styles.css`, so a token the layout does
not paint is never part of the bound, and one it paints is never left out.

Checking the colour stops alone does not bound contrast: a channel-wise
midpoint of two stops that each pass can fail, since luminance is not
linear in the channels. The limits of 3 layers and 8 stops per gradient
remain as complexity bounds; a style that needs more is refused.

## Testing a style

```sh
pnpm styles:check   # the R4b checks on every offered style
pnpm build          # runs the same checks, then builds
pnpm test:e2e       # every offered style in light and dark, with axe
```

`pnpm dev` serves the page with the Style control, so a new style can be
compared with the others live. The checks live in
`scripts/lib/style-checks.ts`; their unit tests in
`tests/unit/style-checks.test.ts` show what each rule refuses.

## The shipped styles

| Style | Look | Background |
|---|---|---|
| Calm (default) | 10px/6px radii, blue accent, white cards with a faint shadow, denser rows | Soft blue wash across the top of the document; static |
| Payload | Square, 1px hairlines, monochrome accent, hairline grid in the intro band, cards collapse into one frame | A blue glow that follows the pointer |
| Slate | Slate-blue surfaces, cyan accent, 12px cards, heavy tight display type | Faint 26px dot grid; a cyan-to-blue spotlight that tracks the pointer |
| Green | Near-black and off-white, one vivid green accent, light display weight, wide-tracked labels, 6px corners, flat | 4px scanlines and a 56px terminal grid; a tight green glow with a slower trailing one |
| Purple | Near-black lit by violet, pill controls, 18px result boxes, 16px cards, light display weight | A violet top wash; a diagonal beam whose angle swings with the pointer, and a soft light under it |
