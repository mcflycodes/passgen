# Word lists

Passphrases are built from one of five unchanged, locally vendored word lists.
Nothing is fetched at run time.

## The lists

| List | Id | Usable words | Real lengths | Default range | License |
|---|---|---:|---|---|---|
| Orchard Street Long (default) | `orchard-long` | 17,576 | 3–15 | 5–10 | CC BY-SA 4.0 |
| Orchard Street Medium | `orchard-medium` | 8,192 | 3–10 | 5–10 | CC BY-SA 4.0 |
| EFF Large | `eff-large` | 7,772 | 3–9 | 5–9 | CC BY 4.0 |
| EFF Short #1 | `eff-short1` | 1,295 | 3–5 | 3–5 | CC BY 4.0 |
| EFF Short #2 | `eff-short2` | 1,295 | 3–10 | 5–10 | CC BY 4.0 |

## Sources and licenses

Orchard Street lists are by Sam Schlinkert, pinned at commit
`4fd015fe9a8e50d837d9f54cb39883bb801da1ed` in
[the primary repository](https://github.com/sts10/orchard-street-wordlists).
EFF lists are by Joseph Bonneau et al., from [EFF](https://www.eff.org/dice).
Full attribution, sources and licenses are in `NOTICE`. CC BY-SA covers the
Orchard list content and its bundled representation only; application code
remains Apache-2.0. The footer's native, collapsed Credits section lists only
the offered lists, with individual authors, license links, source links and
usable counts.

## Choosing the offered lists

Deployment configuration uses `passphrase.wordLists.default` and
`passphrase.wordLists.offered`, an array of `{ id, defaultMin, defaultMax }`,
using the ids in the table above. Unknown ids, duplicates, an empty offered set,
an unavailable default, and ranges outside the corresponding real lengths fail
validation. See [Configuration](Configuration.md).

In the page, each list always exposes its real shortest and longest words.
Switching lists clamps the existing endpoints to those bounds and recalculates
strength. A deployment offering one list hides the dropdown. Saved defaults
include the selected list and range; Reset restores the deployment's defaults.

How passphrases are put together from these words is described in
[How it works](How-it-works.md#passphrases).

## Reference: how the lists are checked

This section is for maintainers and reviewers; you do not need it to deploy or
configure PassGen.

### Build checks

The build checks each raw SHA-256 against the verifier's pin and sidecar;
independent gate pins also lock the bytes. It validates entry counts, unique
lowercase a-z words and the complete length distribution. Dice codes are
removed from the EFF modules, and the existing filtering rule excludes four
hyphenated Large entries and `yo-yo` from each Short list.

`pnpm wordlist:gen` emits the local modules; `pnpm wordlist:check` and every
production build require them to match the authenticated inputs exactly.
All five lists and every allowed length range are tested for unique decoding
without separators before counting entropy.

### Dictionary words and the attribution check

The attribution gate blanks only the explicitly reviewed collision words in
`DICTIONARY_COLLISIONS`, within authenticated data lines and the verified
word-data literal. Bundles apply the same limited exception to verified string
or constant template literals. Every other dictionary word and all surrounding
content remain scanned. Browser checks retain rendered `innerText`, validate
marked output before replacing it with a placeholder in that rendered scan,
and separately scan every output with only the allowlisted words blanked.
Attributes, comments, CSS content and non-output text remain scanned.
