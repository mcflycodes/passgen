import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_WORD_LENGTH, MIN_WORD_LENGTH, WORDS } from "../../src/core/wordlist.ts";

/** Sardinas–Patterson: propagate unmatched suffixes until empty or a fixed point. */
function uniquelyDecodable(words: readonly string[]): boolean {
  const code = new Set(words);
  const pending = new Set<string>();
  for (const word of words)
    for (let split = 1; split < word.length; split++)
      if (code.has(word.slice(0, split))) pending.add(word.slice(split));
  const visited = new Set<string>();
  while (pending.size) {
    const suffix = pending.values().next().value as string;
    pending.delete(suffix);
    if (code.has(suffix)) return false;
    if (visited.has(suffix)) continue;
    visited.add(suffix);
    for (let split = 1; split < suffix.length; split++)
      if (code.has(suffix.slice(0, split))) pending.add(suffix.slice(split));
    for (const word of words) if (word.startsWith(suffix)) pending.add(word.slice(suffix.length));
  }
  return true;
}

test("Sardinas–Patterson positive and negative controls", () => {
  assert.equal(uniquelyDecodable(["ab", "aba", "ba"]), false);
  assert.equal(uniquelyDecodable(["a", "ab"]), true);
});
for (let min = MIN_WORD_LENGTH; min <= MAX_WORD_LENGTH; min++)
  for (let max = min; max <= MAX_WORD_LENGTH; max++)
    test(`separator-free real word pool ${min}–${max} is uniquely decodable`, () => {
      assert.equal(uniquelyDecodable(WORDS.filter((word) => word.length >= min && word.length <= max)), true);
    });
