# Configuration

One file, `src/config/config.json`, holds the product defaults and limits, the
offered styles, word lists and the page text. A release ZIP uses the shipped
configuration; to change it, edit this file and build from a reviewed tag (see
[Build from a reviewed tag](self-hosting.md#build-from-a-reviewed-tag)).

## The configuration file

`src/config/config.json` is imported as JSON; there is no runtime dependency.
`src/config/validate.ts` checks the schema and security invariants before Vite
builds and in unit tests. Invalid configuration stops the build before any
files are emitted. The combined gates prove this with invalid configuration
fixtures.

## Page text and controls

The build fills `index.html` from the configuration (`scripts/lib/page-template.ts`):
the header tagline, the optional intro headline and paragraph, the control
defaults and bounds, the style options, the separator symbols and the two
outward links are inserted as escaped plain text and attribute values at build
time, with length caps checked by the validator and the result scanned by the
attribution and host-name checks.

- An empty tagline leaves the tagline out.
- `text.intro.enabled: false` leaves the intro out.
- One offered style leaves the Style control out (see [Styles](Styles.md)).
- One offered word list hides the word-list dropdown (see [Word lists](Word-lists.md)).

The footer also shows the version from `package.json`.

## Links

`links.repoUrl` is the repository link beside the Style control and
`links.licenseUrl` is the "Apache-2.0" link in the footer. Each is an `https`
URL, written in its normalised form with no credentials, or empty to leave
that link out. They render as plain anchors with `rel="noopener noreferrer"`,
and cause no request. The footer also carries source and license URLs only for
the offered word lists, restricted to designated Credits anchors. The
host-name checks accept each one exactly as configured, as an anchor's `href`
and as the configuration string in the bundle, and nothing else.

## Saved settings

Saved settings are explicit. "Save as my default" writes one snapshot of
every setting of both generators, the theme and the style to the browser's
local storage under one versioned key (`src/boot/storage.ts`); "Reset to
defaults" removes it and restores the configured defaults. A change made after
saving is not saved unless Save is pressed again, so a one-off tweak never
becomes the default.

- Each press is confirmed by a short status beside the buttons, announced
  politely to screen readers, and a highlight on the button that fades out (or
  simply ends under reduced motion).
- A stored record is checked by `src/boot/stored-settings.ts` both before the
  first paint and when the app starts, never includes a generated value, and is
  removed when it fails the check.
- Nothing is written to storage until Save or Reset is pressed, not even a
  probe. A browser whose storage cannot be read says so under the buttons, and
  one that refuses the write says so when Save is pressed.
- Saved settings use schema v5; older settings are ignored and removed on Save
  or Reset.
- Saved defaults belong to the browser's origin: changing domains resets them.

## Settings codes

A settings code carries the same settings to another browser without a server,
an account, a network request or a URL. "Get settings code" under the Save
buttons shows a short code such as `PG1-ZW` (the shipped defaults) for the
settings on the page; type it into "Code to apply" in the other browser and
press Apply. The settings change at once, as if set by hand, but nothing is
saved until Save as my default is pressed there. A code holds settings only,
never a password or passphrase, and no message repeats what was typed.

- Format (`src/core/settings-code.ts`): `PG1-`, then Crockford base32 (digits
  and capitals without I, L, O and U) in groups of four, ending in two check
  characters. Case, spaces and hyphens are ignored everywhere, so `pg1 zw` and
  `PG1ZW` are `PG1-ZW`; I and L read as 1, O as 0. The version is the one
  character after `PG`.
  The check catches every single wrong character and every swap of two
  adjacent characters.
- Only settings that differ from the defaults PassGen 1.4 shipped with are in
  the code, so typical codes are short: the defaults are `PG1-ZW`, a longer
  password with a few changes is under a dozen characters, and changing every
  setting gives about 60. The same settings always give the same code, on any
  deployment.
- A code is checked by the same validator as saved settings, against this
  page's bounds, styles and word lists, before anything changes. A code with a
  typo, from another version, or asking for something this page does not offer
  (a style or word list it leaves out, a length beyond its limits) is refused
  with a message and changes nothing. Strength is always computed from the
  applied settings, so a code cannot make the meter claim more than they give.
- Versions: a new setting gets the next unused field number in the code, with
  its default at that time as its baseline, so older codes still load and get
  that default. An older page meeting a field number it does not know refuses
  the code as coming from a newer version. Changing what an existing field or
  a baseline means requires a new prefix (`PG2-`); a page refuses prefixes it
  does not know.

## Strength estimates

Unspecified slow-hash and online attack estimates are `null`: consumers must
show them as unavailable, rather than substituting an estimate. The optional
future quantum estimate is also unavailable. The wordlist build computes the
pool size for the configured default filter and checks that the defaults reach
the configured Strong threshold (at least 80 bits). No derived word count is
stored in configuration.
