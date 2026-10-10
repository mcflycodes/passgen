// Immutable wordlist metadata. Vendored bytes and emitted modules are checked at build time.
import { WORDS as effLarge } from "./wordlist.ts";
import { WORDS as eff_short1 } from "./wordlist-eff-short1.ts";
import { WORDS as eff_short2 } from "./wordlist-eff-short2.ts";
import { WORDS as orchard_long } from "./wordlist-orchard-long.ts";
import { WORDS as orchard_medium } from "./wordlist-orchard-medium.ts";

export const WORDLIST_SOURCES = {
  orchard: {
    name: "Orchard Street Wordlists",
    author: "Sam Schlinkert",
    license: "CC BY-SA 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
    url: "https://github.com/sts10/orchard-street-wordlists",
  },
  eff: {
    name: "EFF wordlists",
    author: "Joseph Bonneau et al.",
    license: "CC BY 4.0",
    licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
    url: "https://www.eff.org/dice",
  },
} as const;
export const WORD_LISTS = {
  "orchard-long": Object.freeze({
    name: "Orchard Street Long",
    min: 3,
    max: 15,
    count: 17576,
    description: "More choices per word for strong, memorable phrases.",
    source: "orchard" as const,
    words: orchard_long,
  }),
  "orchard-medium": Object.freeze({
    name: "Orchard Street Medium",
    min: 3,
    max: 10,
    count: 8192,
    description: "Common words with a balance of length and choice.",
    source: "orchard" as const,
    words: orchard_medium,
  }),
  "eff-large": Object.freeze({
    name: "EFF Large",
    min: 3,
    max: 9,
    count: 7772,
    description: "Designed for memorable phrases with a large choice of words.",
    source: "eff" as const,
    words: effLarge,
  }),
  "eff-short1": Object.freeze({
    name: "EFF Short #1",
    min: 3,
    max: 5,
    count: 1295,
    description: "Short words for easier typing. Use more words for strength.",
    source: "eff" as const,
    words: eff_short1,
  }),
  "eff-short2": Object.freeze({
    name: "EFF Short #2",
    min: 3,
    max: 10,
    count: 1295,
    description: "Distinctive words for easier recognition and recall.",
    source: "eff" as const,
    words: eff_short2,
  }),
} as const;
export type WordListId = keyof typeof WORD_LISTS;
export function isWordListId(value: unknown): value is WordListId {
  return typeof value === "string" && Object.hasOwn(WORD_LISTS, value);
}
export function wordListDescription(id: WordListId): string {
  const list = WORD_LISTS[id];
  return `${list.count.toLocaleString("en-US")} words, ${list.min}–${list.max} letters. ${list.description}`;
}
