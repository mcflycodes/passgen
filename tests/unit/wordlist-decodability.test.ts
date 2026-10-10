import assert from "node:assert/strict";
import { test } from "node:test";
import { WORD_LISTS } from "../../src/core/wordlists.ts";

/** Sardinas–Patterson: propagate unmatched suffixes until empty or a fixed point. */
function uniquelyDecodable(words: readonly string[]): boolean {
  const code = new Set(words);
  const pending = new Set<string>();
  const extensions = new Map<string, Set<string>>();
  for (const word of words)
    for (let split = 1; split < word.length; split++) {
      const prefix = word.slice(0, split);
      if (!extensions.has(prefix)) extensions.set(prefix, new Set());
      extensions.get(prefix)?.add(word.slice(split));
      if (code.has(prefix)) pending.add(word.slice(split));
    }
  const visited = new Set<string>();
  while (pending.size) {
    const suffix = pending.values().next().value as string;
    pending.delete(suffix);
    if (code.has(suffix)) return false;
    if (visited.has(suffix)) continue;
    visited.add(suffix);
    for (let split = 1; split < suffix.length; split++)
      if (code.has(suffix.slice(0, split))) pending.add(suffix.slice(split));
    for (const tail of extensions.get(suffix) ?? []) pending.add(tail);
  }
  return true;
}

test("Sardinas–Patterson positive and negative controls", () => {
  assert.equal(uniquelyDecodable(["ab", "aba", "ba"]), false);
  assert.equal(uniquelyDecodable(["a", "ab"]), true);
});
for (const [id, list] of Object.entries(WORD_LISTS))
  for (let min = list.min; min <= list.max; min++)
    for (let max = min; max <= list.max; max++)
      test(`separator-free ${id} pool ${min}–${max} is uniquely decodable`, () => {
        const pool = list.words.filter((word) => word.length >= min && word.length <= max);
        assert.ok(pool.length > 0);
        assert.equal(new Set(pool).size, pool.length);
        assert.equal(uniquelyDecodable(pool), true);
      });
