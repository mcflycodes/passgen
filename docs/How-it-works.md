# How it works

How PassGen picks passwords and passphrases, and how the page is wired. All
randomness comes from `crypto.getRandomValues`, selected without modulo bias, and
generated values never leave the tab.

## Passwords

`src/core/password.ts` exposes `generatePassword`, `generatePasswords`,
`planPassword`, `normalizeCounts`, `countPasswords` and `defaultOptions`.

Each selected character type (lowercase, uppercase, numbers, symbols; Simple and
Complex symbols count as one type) has a Min and a Max count, with Min 1 and
Max equal to the length by default. Every password of the chosen length that
meets every limit is exactly equally likely:

1. The number of characters of each type is drawn in proportion to how many valid
   passwords have those counts, using exact integer arithmetic and the unbiased
   randomness core.
2. The type labels are shuffled with Fisher-Yates.
3. Each position is filled with a uniform pick from its type.

`countPasswords` gives the exact number of valid passwords for a request, which
the strength meter takes the entropy from. Invalid requests raise typed errors
before any randomness is drawn, and no error carries generated output.

## Passphrases

`src/core/passphrase.ts` exposes `generatePassphrase`, `filteredWordCount` and
`defaultPassphraseOptions`. Each word is picked independently with replacement
from the selected [word list](Word-lists.md); each separator digit and each
optional random capitalization bit use the unbiased randomness core. Invalid
options and empty pools raise typed errors without returning output.

- **Numbers** have 1–3 digits (default 2), including leading zeros.
- **Symbols** default to Random: each slot is an independent pick. Random
  (unique) never repeats within a separator and uses every symbol once before
  starting another round. When slots exceed the alphabet size, repeats are
  spread evenly and the panel shows a note. Fixed symbols remain available.
- **Symbol position** can be Both sides (default), Before or After a number;
  without numbers each separator has one symbol.
- **Capitalize** offers Off (default), Random (one independent case bit per
  word), and Every word (no added entropy).

The meter counts all valid sequences exactly.

## Interface

`src/main.ts` wires the page.

| File | Job |
|---|---|
| `src/ui/password.ts`, `src/ui/passphrase.ts` | Bind the controls to the generators and turn each core error into a message with generation disabled. |
| `src/ui/settings.ts` | Holds every user-changeable setting in one serialisable object and binds the Save and Reset buttons. |
| `src/ui/settings-code.ts` | Shows the live settings code and applies a typed one. |
| `src/ui/theme.ts` | Applies the theme and style choices. |
| `src/ui/appearance.ts` | Opens and closes the narrow header's Appearance panel. |
| `src/ui/pointer.ts` | The shared pointer effect for decorative backgrounds. |
| `src/ui/meter.ts`, `src/ui/results.ts` | The strength meter and the extra-results markup. |

### Layout

The page supports widths down to 320 CSS pixels with no horizontal scrolling,
including with enlarged text spacing; narrower viewports are not supported.

- The header is pinned at the top at every width. From 900px it is one row:
  the PassGen name, the Style control, the theme switch, a separator, then
  "Save as my default" and "Reset to defaults". Below 900px it is a compact
  53px row: the name, an Appearance button that opens the Style and theme
  controls as a panel (Escape or a click outside closes it and returns focus
  to the button), the separator, then Save and Reset with short labels and
  their full names for assistive technology. Focused controls always scroll
  clear of the pinned header. A viewport under 400px tall, such as a phone on
  its side or 400% zoom, leaves the header in normal flow instead, so it does
  not take a large share of the little height there is.
- The bottom of the page holds the privacy line, the meta line (version,
  license, Credits and GitHub) and the Settings code box, in that reading and
  keyboard order at every width. From 1200px they are three columns, the
  first two centred against the box; from 901px the privacy and meta lines
  stack beside the box; at 900px and below all three stack. Credits opens a
  full-width panel below them.

The theme and style are applied before the first paint; see
[Styles](Styles.md#theme-and-style-at-page-load). Saved settings are described
in [Configuration](Configuration.md#saved-settings).
