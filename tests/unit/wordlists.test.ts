import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { scanText } from "../../scripts/lib/attribution-scan.ts";
import { checkHtml, checkJs, cspMetaTag } from "../../scripts/lib/dist-checks.ts";
import { renderPage } from "../../scripts/lib/page-template.ts";
import { EXTRA_WORDLISTS, verifiedExtraWordlist, verifiedWordlist } from "../../scripts/lib/wordlist.ts";
import { sourceAttributionInput } from "../../scripts/lib/wordlist-attribution.ts";
import { config, configuredLinks, validateConfig, wordListCredits } from "../../src/config/validate.ts";
import { passphraseEntropy } from "../../src/core/entropy.ts";
import {
  defaultPassphraseOptions,
  filteredWordCount,
  generatePassphrase,
  switchWordList,
} from "../../src/core/passphrase.ts";
import { WORD_LISTS, WORDLIST_SOURCES, type WordListId } from "../../src/core/wordlists.ts";
import { defaultSettings, parseStoredSettings, serializeSettings } from "../../src/ui/settings.ts";
import { topBits, wordsSource } from "./random-sources.ts";

const root = join(import.meta.dirname, "../..");
const ids = Object.keys(WORD_LISTS) as WordListId[];

test("deployment word lists reject unknown, empty, unavailable default and invalid ranges", () => {
  for (const mutate of [
    (c: typeof config) => {
      required(c.passphrase.wordLists.offered[0]).id = "unknown";
    },
    (c: typeof config) => {
      c.passphrase.wordLists.offered = [];
    },
    (c: typeof config) => {
      c.passphrase.wordLists.default = "unknown";
    },
    (c: typeof config) => {
      c.passphrase.wordLists.offered = c.passphrase.wordLists.offered.slice(1);
    },
    (c: typeof config) => {
      required(c.passphrase.wordLists.offered[0]).defaultMin = 2;
    },
    (c: typeof config) => {
      required(c.passphrase.wordLists.offered[0]).defaultMax = 16;
    },
    (c: typeof config) => {
      required(c.passphrase.wordLists.offered[0]).defaultMax = 4;
    },
    (c: typeof config) => {
      c.passphrase.wordLists.offered.push(required(c.passphrase.wordLists.offered[0]));
    },
  ]) {
    const copy = structuredClone(config);
    mutate(copy);
    assert.throws(() => validateConfig(copy), /wordLists/);
  }
});

test("list switching clamps both endpoints and preserves a valid current range", () => {
  const long = { ...defaultPassphraseOptions, minWordLength: 10, maxWordLength: 15 };
  assert.deepEqual(switchWordList(long, "eff-short1"), {
    ...long,
    wordList: "eff-short1",
    minWordLength: 5,
    maxWordLength: 5,
  });
  for (const id of ids) {
    const next = switchWordList(defaultPassphraseOptions, id);
    assert.equal(next.wordList, id);
    assert.equal(next.minWordLength, 5);
    assert.equal(next.maxWordLength, Math.min(10, WORD_LISTS[id].max));
    assert.equal(
      filteredWordCount(next),
      WORD_LISTS[id].words.filter((w) => w.length >= next.minWordLength && w.length <= next.maxWordLength).length,
    );
  }
});

for (const wordList of ids) {
  test(`exact entropy and brute-force generation for ${wordList}`, () => {
    const list = WORD_LISTS[wordList];
    const pool = list.words.filter((w) => w.length === list.min);
    const options = {
      ...defaultPassphraseOptions,
      wordList,
      minWordLength: list.min,
      maxWordLength: list.min,
      words: 2,
      number: false,
      symbol: false,
    };
    const generated = new Set<string>();
    const width = Math.ceil(Math.log2(pool.length));
    for (let a = 0; a < pool.length; a++)
      for (let b = 0; b < pool.length; b++) {
        const output = generatePassphrase(options, wordsSource([topBits(a, width), topBits(b, width)]));
        assert.equal(output, `${pool[a]}${pool[b]}`);
        generated.add(output);
      }
    assert.equal(filteredWordCount(options), pool.length);
    assert.equal(passphraseEntropy(options).count, BigInt(generated.size));
    assert.equal(generated.size, pool.length ** 2);
  });
  test(`saved list and deployment defaults round trip for ${wordList}`, () => {
    const copy = structuredClone(config);
    copy.passphrase.wordLists.default = wordList;
    const offered = required(copy.passphrase.wordLists.offered.find((entry) => entry.id === wordList));
    const settings = defaultSettings(copy);
    assert.equal(settings.passphrase.wordList, wordList);
    assert.equal(settings.passphrase.minWordLength, offered.defaultMin);
    assert.equal(settings.passphrase.maxWordLength, offered.defaultMax);
    const text = serializeSettings(settings, copy);
    assert.ok(text);
    assert.deepEqual(parseStoredSettings(text, copy), settings);
    for (const patch of [
      { wordList: "unknown" },
      { minWordLength: WORD_LISTS[wordList].min - 1 },
      { maxWordLength: WORD_LISTS[wordList].max + 1 },
    ]) {
      const record = JSON.parse(text);
      Object.assign(record.settings.passphrase, patch);
      assert.equal(parseStoredSettings(JSON.stringify(record), copy), null);
    }
  });
}

test("authenticated new word data only exempts explicit words; tampering and outside credits fail", () => {
  for (const spec of EXTRA_WORDLISTS) {
    const { raw, words } = verifiedExtraWordlist(root, spec);
    assert.deepEqual(scanText(spec.file, sourceAttributionInput(root, spec.file, raw)), []);
    assert.throws(() => sourceAttributionInput(root, spec.file, `${raw}extra\n`), /authenticated bytes/);
    const literal = JSON.stringify(words.join(" "));
    assert.deepEqual(checkJs("data.js", `const words = ${literal};`), []);
    const collision = words.find((word) => scanText("word", word).length > 0);
    if (collision) {
      assert.ok(checkJs("data.js", `const words = ${literal}; const credit = "${collision}";`).length);
      assert.ok(
        checkJs("data.js", `const words = ${JSON.stringify(words.join(" ").replace(required(words[0]), "tampered"))};`)
          .length,
      );
    }
  }
});

test("template credits list exactly the offered data and hide the one-list dropdown", () => {
  const index = readFileSync(join(root, "index.html"), "utf8");
  for (const offered of [
    config.passphrase.wordLists.offered,
    [required(config.passphrase.wordLists.offered[0])],
    [required(config.passphrase.wordLists.offered[2])],
  ]) {
    const copy = structuredClone(config);
    copy.passphrase.wordLists.offered = offered;
    copy.passphrase.wordLists.default = required(offered[0]).id;
    const html = renderPage(index, copy, { version: "1.3.0" });
    assert.equal((html.match(/<li data-word-list=/g) ?? []).length, offered.length);
    assert.equal(html.includes('id="pp-word-list"'), offered.length > 1);
    assert.ok(!html.includes('<details id="wordlist-credits" class="wordlist-credits" open'));
    for (const credit of wordListCredits(copy)) {
      assert.ok(html.includes(credit.name));
      assert.ok(html.includes(credit.source.author));
      assert.ok(html.includes(credit.source.licenseUrl));
      assert.ok(html.includes(`${credit.count.toLocaleString("en-US")} usable words`));
    }
  }
});

test("source URLs are accepted only on designated credits anchors, never elsewhere", () => {
  const allowed = configuredLinks(config);
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8">${cspMetaTag()}</head><body>`;
  for (const source of Object.values(WORDLIST_SOURCES))
    for (const [kind, url] of [
      ["source", source.url],
      ["license", source.licenseUrl],
    ]) {
      const anchor = `<a data-wordlist-credit="${kind}" href="${url}">Link</a>`;
      const details = `<footer class="foot"><details id="wordlist-credits" class="wordlist-credits"><summary>Credits</summary>${anchor}</details></footer>`;
      assert.deepEqual(checkHtml("index.html", `${head}${details}</body></html>`, allowed), []);
      assert.ok(checkHtml("index.html", `${head}${anchor}</body></html>`, allowed).length);
      assert.ok(
        checkHtml(
          "index.html",
          `${head}${details.replace('<footer class="foot">', "").replace("</footer>", "")}</body></html>`,
          allowed,
        ).length,
      );
      assert.ok(checkHtml("index.html", `${head}<p>${url}</p></body></html>`, allowed).length);
      assert.ok(checkHtml("index.html", `${head}${details}${anchor}</body></html>`, allowed).length);
    }
});

function required<T>(value: T | undefined): T {
  assert.ok(value !== undefined);
  return value;
}

test("runtime list metadata matches the authenticated words and real lengths", () => {
  for (const id of ids) {
    const list = WORD_LISTS[id];
    const spec = EXTRA_WORDLISTS.find((entry) => entry.id === id);
    const verified = spec ? verifiedExtraWordlist(root, spec) : verifiedWordlist(root);
    assert.deepEqual(list.words, verified.words);
    assert.equal(list.count, verified.words.length);
    assert.equal(list.min, Math.min(...verified.words.map((word) => word.length)));
    assert.equal(list.max, Math.max(...verified.words.map((word) => word.length)));
  }
});
