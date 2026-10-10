import { join } from "node:path";
import { blankDictionaryCollisions, verifiedWordData } from "../../scripts/lib/wordlist-attribution.ts";
import { config } from "../../src/config/validate.ts";

const dictionary = new Set(verifiedWordData(join(import.meta.dirname, "../..")).split(" "));
const { min, max } = config.passphrase.words;
const symbols = config.password.characters.simple;
const isWord = (word: string) => /^[a-zA-Z][a-z]*$/.test(word) && dictionary.has(word.toLowerCase());
const isWords = (words: string[]) => words.length >= min && words.length <= max && words.every(isWord);

/** A joined value must segment into allowed words; memoize the bounded search. */
function joinedWords(text: string): boolean {
  const seen = new Set<string>();
  function visit(offset: number, count: number): boolean {
    if (offset === text.length) return count >= min && count <= max;
    if (count >= max || seen.has(`${offset}:${count}`)) return false;
    seen.add(`${offset}:${count}`);
    for (let length = config.passphrase.wordLength.min; length <= config.passphrase.wordLength.max; length++) {
      if (isWord(text.slice(offset, offset + length)) && visit(offset + length, count + 1)) return true;
    }
    return false;
  }
  return visit(0, 0);
}

/** Recognizes complete possible passphrases before any data exception applies. */
export function isGeneratedPassphrase(text: string): boolean {
  let valid = /^[a-zA-Z]+$/.test(text) && joinedWords(text);
  // Random modes can use a different symbol for each word gap.
  const segments = text.split(/([^a-zA-Z]+)/);
  const words = segments.filter((_, index) => index % 2 === 0);
  const gaps = segments.filter((_, index) => index % 2 === 1);
  if (
    isWords(words) &&
    (gaps.every((gap) => gap.length === 1 && symbols.includes(gap)) ||
      [1, 2, 3].some((digits) =>
        ["both", "before", "after", "none"].some((position) =>
          gaps.every((gap) => {
            const before = position === "both" || position === "before" ? 1 : 0;
            const after = position === "both" || position === "after" ? 1 : 0;
            return (
              gap.length === digits + before + after &&
              (!before || symbols.includes(gap[0] as string)) &&
              (!after || symbols.includes(gap.at(-1) as string)) &&
              /^[0-9]+$/.test(gap.slice(before, before + digits))
            );
          }),
        ),
      ))
  )
    valid = true;
  for (const symbol of symbols) {
    const parts = text.split(symbol);
    if (isWords(parts)) valid = true;
    if (
      parts.length >= 3 &&
      parts.length % 2 === 1 &&
      parts.every((part, index) => (index % 2 ? /^[0-9]{2}$/.test(part) : isWord(part))) &&
      (parts.length + 1) / 2 >= min &&
      (parts.length + 1) / 2 <= max
    )
      valid = true;
  }
  const numbered = text.split(/[0-9]{1,3}/);
  if (isWords(numbered)) valid = true;
  return valid;
}

/** Valid output blanks only known collisions; every other word remains scanned. */
export function generatedPassphraseInput(text: string): string {
  return isGeneratedPassphrase(text) ? text.replace(/[a-z]+/gi, blankDictionaryCollisions) : text;
}
