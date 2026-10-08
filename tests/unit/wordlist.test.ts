import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { checkWordlist, parseWordlist } from "../../scripts/lib/wordlist.ts";
import { MAX_WORD_LENGTH, MIN_WORD_LENGTH, WORDS } from "../../src/core/wordlist.ts";

const root = join(import.meta.dirname, "../..");
const raw = readFileSync(join(root, "vendor/eff_large_wordlist.txt"), "utf8");
test("module exactly matches the authenticated list and its four exclusions", () => {
  checkWordlist(root);
  const list = parseWordlist(raw);
  assert.deepEqual(list.excluded, ["drop-down", "felt-tip", "t-shirt", "yo-yo"]);
  assert.deepEqual(list.words, WORDS);
  assert.equal(WORDS.length, 7772);
  assert.equal(MIN_WORD_LENGTH, 3);
  assert.equal(MAX_WORD_LENGTH, 9);
  assert.equal(new Set(WORDS).size, WORDS.length);
  assert.ok(WORDS.every((word) => /^[a-z]+$/.test(word)));
});
for (const [name, change, error] of [
  ["count", raw.slice(raw.indexOf("\n") + 1), /7776/],
  ["dice code", raw.replace("11111", "01111"), /dice/],
  ["duplicate dice code", raw.replace("11112", "11111"), /dice/],
  ["uppercase", raw.replace("abacus", "Abacus"), /lowercase/],
  ["duplicate", raw.replace("abdomen", "abacus"), /duplicate words/],
  ["fifth hyphenated word", raw.replace("abacus", "aba-cus"), /four hyphenated/],
  ["minimum length", raw.replace("abacus", "ab"), /length range/],
  ["maximum length", raw.replace("abacus", "abcdefghij"), /length range/],
] as const)
  test(`semantic validation rejects ${name}`, () => assert.throws(() => parseWordlist(change), error));
