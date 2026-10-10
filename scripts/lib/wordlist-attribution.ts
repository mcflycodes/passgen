import { DICTIONARY_COLLISIONS } from "./attribution-patterns.ts";
import {
  checkWordlist,
  EXTRA_WORDLISTS,
  verifiedExtraWordlist,
  verifiedWordlist,
  WORDLIST_MODULE_PATH,
  WORDLIST_PATH,
} from "./wordlist.ts";

/** Authenticated data only: the module must also match the build-time emitter. */
export function verifiedWordData(root: string): string {
  checkWordlist(root);
  return verifiedWordlist(root).words.join(" ");
}

export function verifiedWordDataSets(root: string): readonly string[] {
  checkWordlist(root);
  return [
    verifiedWordlist(root).words.join(" "),
    ...EXTRA_WORDLISTS.map((spec) => verifiedExtraWordlist(root, spec).words.join(" ")),
  ];
}

/** Preserve offsets while blanking only whole words in the explicit collision set. */
export function blankDictionaryCollisions(text: string): string {
  return text.replace(/\b[a-z]+\b/gi, (word) =>
    DICTIONARY_COLLISIONS.includes(word.toLowerCase()) ? " ".repeat(word.length) : word,
  );
}

export function sourceAttributionInput(root: string, file: string, text: string): string {
  const spec = EXTRA_WORDLISTS.find((entry) => entry.file === file || entry.module === file);
  if (spec) {
    const { raw, words } = verifiedExtraWordlist(root, spec);
    if (file === spec.file) {
      if (text !== raw) throw new Error("Wordlist attribution input differs from authenticated bytes");
      return text.replace(/^(?:[1-6]{4}\t)?[a-z-]+$/gm, blankDictionaryCollisions);
    }
    checkWordlist(root);
    return text.replace(JSON.stringify(words.join(" ")), blankDictionaryCollisions);
  }
  if (file === WORDLIST_PATH) {
    const { raw } = verifiedWordlist(root);
    if (text !== raw) throw new Error("Wordlist attribution input differs from authenticated bytes");
    return text.replace(/^[1-6]{5}\t[a-z-]+$/gm, blankDictionaryCollisions);
  }
  if (file === WORDLIST_MODULE_PATH) {
    const literal = JSON.stringify(verifiedWordData(root));
    return text.replace(literal, blankDictionaryCollisions);
  }
  return text;
}
