// The settings code: every valid settings record round-trips through its
// code and the stored-settings validator unchanged; codes are deterministic
// and short for typical settings; the check characters catch every single
// changed character and every swap of two adjacent characters; and every
// way a code can be wrong is refused, by the format or by the same validator
// saved settings use, without anything being applied.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { SETTINGS_SCHEMA_VERSION } from "../../src/boot/storage.ts";
import { type Config, config } from "../../src/config/validate.ts";
import { generatePassphrase } from "../../src/core/passphrase.ts";
import { countPasswords, generatePassword, planPassword } from "../../src/core/password.ts";
import { BASELINE, decodeSettingsCode, encodeSettingsCode } from "../../src/core/settings-code.ts";
import { isWordListId, WORD_LISTS } from "../../src/core/wordlists.ts";
import { defaultSettings, type Settings, validateStoredSettings } from "../../src/ui/settings.ts";
import {
  CODE_APPLIED_STATUS,
  CODE_ERROR_STATUS,
  CODE_HINT,
  CODE_INVALID_STATUS,
  CODE_READY_STATUS,
  readSettingsCode,
  settingsCode,
} from "../../src/ui/settings-code.ts";

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KNOWN_WORDS_CODE = "PG1-0MVY-81X";

/** A small deterministic generator (xorshift32), so a failure is reproducible from its seed. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  const next = () => {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    return x / 0x1_0000_0000;
  };
  return {
    int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T,
    chance: (p: number) => next() < p,
  };
}

/** Random settings within the configured bounds; most pass the validator, the rest are filtered out by the caller. */
function randomSettings(r: ReturnType<typeof rng>): Settings {
  const c = config;
  const length = r.chance(0.3) ? c.password.length.default : r.int(c.password.length.min, c.password.length.max);
  const count = () => {
    const min = r.chance(0.5) ? 1 : r.int(0, Math.min(length, 6));
    const max = r.chance(0.5) ? length : r.int(min, length);
    return { min, max };
  };
  const simple = r.chance(0.7);
  const list = r.pick(c.passphrase.wordLists.offered);
  if (!isWordListId(list.id)) throw new Error("unknown list");
  const bounds = WORD_LISTS[list.id];
  const minWordLength = r.chance(0.5) ? list.defaultMin : r.int(bounds.min, bounds.max);
  const maxWordLength = r.chance(0.5) ? Math.max(minWordLength, list.defaultMax) : r.int(minWordLength, bounds.max);
  return {
    theme: r.pick(["system", "light", "dark"] as const),
    style: r.pick(c.style.offered).id,
    password: {
      length,
      lowercase: r.chance(0.8),
      uppercase: r.chance(0.8),
      numbers: r.chance(0.8),
      simple,
      complex: simple && r.chance(0.7),
      excludeLookAlikes: r.chance(0.3),
      dontStartWithSymbol: r.chance(0.7),
      counts: { lowercase: count(), uppercase: count(), numbers: count(), symbols: count() },
    },
    passphrase: {
      wordList: list.id,
      words: r.int(c.passphrase.words.min, c.passphrase.words.max),
      minWordLength,
      maxWordLength,
      number: r.chance(0.7),
      symbol: r.chance(0.7),
      excludeLookAlikes: r.chance(0.3),
      separatorSymbol: r.pick(["random", "random-unique", ...c.password.characters.simple]),
      numberDigits: r.int(1, 3),
      symbolPosition: r.pick(["both", "before", "after"] as const),
      capitalize: r.pick(["off", "random", "every"] as const),
    },
  };
}

/** Valid random settings: those the stored-settings validator accepts. */
function validSettings(seed: number, wanted: number): Settings[] {
  const r = rng(seed);
  const out: Settings[] = [];
  for (let tries = 0; out.length < wanted && tries < wanted * 20; tries += 1) {
    const s = validateStoredSettings({ version: SETTINGS_SCHEMA_VERSION, settings: randomSettings(r) }, config);
    if (s) out.push(s);
  }
  assert.equal(out.length, wanted, "the generator should find enough valid settings");
  return out;
}

/** The typed characters of a code, without the prefix and hyphens. */
const charsOf = (code: string) => code.slice(4).replaceAll("-", "");

// An independent implementation of the check, so crafted codes test the decoder, not a copy of it.
function withCheck(body: string): string {
  let sum = 1;
  for (const [i, char] of [...body].entries()) sum = (sum + (33 + i) * ALPHABET.indexOf(char)) % 1021;
  const check = (1021 - sum) % 1021;
  return `PG1-${body}${ALPHABET[Math.floor(check / 32)]}${ALPHABET[check % 32]}`;
}

/** A code from a bit string: padded with zeros to whole characters, with a valid check. */
function craft(bits: string): string {
  const padded = bits.padEnd(Math.ceil(bits.length / 5) * 5, "0");
  let body = "";
  for (let i = 0; i < padded.length; i += 5) body += ALPHABET[Number.parseInt(padded.slice(i, i + 5), 2)];
  return withCheck(body);
}
function bin(value: number, width: number): string {
  if (value < 0 || value >= 2 ** width) throw new RangeError(`${value} does not fit ${width} bits`);
  return value.toString(2).padStart(width, "0");
}
const field = (number: number) => bin(number, 5);

type Draft<T> = { -readonly [K in keyof T]: T[K] extends object ? Draft<T[K]> : T[K] };

/** A copy of the defaults with `edit` applied. */
function edited(edit: (s: Draft<Settings>) => void): Settings {
  const s = structuredClone(defaultSettings(config)) as Draft<Settings>;
  edit(s);
  return s;
}

describe("round trip", () => {
  test("the shipped defaults have the shortest code, which reads back as the defaults", () => {
    const code = settingsCode(defaultSettings(config), config);
    assert.equal(code, "PG1-ZW");
    assert.deepEqual(readSettingsCode(code, config), { ok: true, settings: defaultSettings(config) });
    assert.deepEqual(decodeSettingsCode(code), { ok: true, settings: BASELINE });
  });

  test("the baseline is valid for the shipped configuration", () => {
    assert.notEqual(validateStoredSettings({ version: SETTINGS_SCHEMA_VERSION, settings: BASELINE }, config), null);
  });

  test("3000 random valid settings read back exactly, through the same validator saved settings use", () => {
    for (const settings of validSettings(1, 3000)) {
      const code = settingsCode(settings, config);
      assert.ok(code, JSON.stringify(settings));
      assert.match(code, /^PG1(-[0-9A-HJKMNP-TV-Z]{1,4})+$/);
      const back = readSettingsCode(code, config);
      assert.deepEqual(back, { ok: true, settings }, code);
    }
  });

  test("codes are deterministic: equal settings give equal codes, and different settings different codes", () => {
    const seen = new Map<string, string>();
    for (const settings of validSettings(2, 1500)) {
      const code = settingsCode(settings, config) as string;
      assert.equal(settingsCode(structuredClone(settings), config), code);
      const key = JSON.stringify(settings);
      const other = seen.get(code);
      if (other !== undefined) assert.equal(other, key, `two settings share ${code}`);
      seen.set(code, key);
    }
  });

  test("a decoded code gives exactly the strength of the settings it came from", () => {
    for (const settings of validSettings(3, 300)) {
      const back = readSettingsCode(settingsCode(settings, config), config);
      assert.ok(back.ok);
      assert.equal(
        countPasswords(planPassword(back.settings.password, config.password)),
        countPasswords(planPassword(settings.password, config.password)),
      );
      assert.deepEqual(back.settings.passphrase, settings.passphrase);
    }
  });

  test("known codes keep their meaning", () => {
    const longer = edited((s) => {
      s.password.length = 32;
      for (const t of ["lowercase", "uppercase", "numbers", "symbols"] as const) s.password.counts[t].max = 32;
    });
    assert.equal(settingsCode(longer, config), "PG1-240S-J");
    assert.deepEqual(readSettingsCode("PG1-240S-J", config), { ok: true, settings: longer });
    const words = edited((s) => {
      s.theme = "dark";
      s.passphrase.words = 7;
      s.passphrase.capitalize = "every";
    });
    const code = settingsCode(words, config) as string;
    assert.deepEqual(readSettingsCode(code, config), { ok: true, settings: words });
    assert.equal(code, KNOWN_WORDS_CODE);
  });

  test("case, spaces, hyphens and the look-alikes I, L and O do not matter", () => {
    const settings = edited((s) => {
      s.password.length = 32;
      for (const t of ["lowercase", "uppercase", "numbers", "symbols"] as const) s.password.counts[t].max = 32;
      s.passphrase.words = 7;
      s.theme = "dark";
    });
    const code = settingsCode(settings, config) as string;
    const want = { ok: true, settings };
    assert.deepEqual(readSettingsCode(code.toLowerCase(), config), want);
    assert.deepEqual(readSettingsCode(`  ${code.replaceAll("-", " ").replace(" ", "-")}  `, config), want);
    assert.deepEqual(readSettingsCode(`PG1-${charsOf(code)}`, config), want);
    const body = charsOf(code);
    if (body.includes("1")) assert.deepEqual(readSettingsCode(`PG1-${body.replaceAll("1", "l")}`, config), want);
    if (body.includes("0")) assert.deepEqual(readSettingsCode(`PG1-${body.replaceAll("0", "O")}`, config), want);
    assert.deepEqual(decodeSettingsCode(withCheck("").replace("PG1-", "pg1-")).ok, true);
    assert.deepEqual(readSettingsCode("PG1-ZW", config).ok, true);
    assert.deepEqual(readSettingsCode("PG1-ZVV", config).ok, false);
    assert.deepEqual(readSettingsCode("PG1-IL", config).ok, false);
  });

  test("a style this version does not list by name still travels, as its own letters", () => {
    const custom: Config = structuredClone(config);
    (custom.style.offered as Array<{ id: string; label: string }>).push({ id: "night-2", label: "Night" });
    const settings = edited((s) => {
      s.style = "night-2";
    });
    const code = settingsCode(settings, custom) as string;
    assert.ok(code);
    assert.deepEqual(readSettingsCode(code, custom), { ok: true, settings });
    // A page that does not offer it refuses the code.
    assert.deepEqual(readSettingsCode(code, config), { ok: false, error: "unavailable" });
  });

  test("code lengths", (t) => {
    const heavy = edited((s) => {
      s.theme = "dark";
      s.style = "purple";
      s.password = {
        length: 64,
        lowercase: true,
        uppercase: true,
        numbers: false,
        simple: true,
        complex: false,
        excludeLookAlikes: true,
        dontStartWithSymbol: false,
        counts: {
          lowercase: { min: 3, max: 40 },
          uppercase: { min: 2, max: 30 },
          numbers: { min: 0, max: 10 },
          symbols: { min: 2, max: 8 },
        },
      };
      s.passphrase = {
        wordList: "eff-large",
        words: 7,
        minWordLength: 4,
        maxWordLength: 8,
        number: false,
        symbol: true,
        excludeLookAlikes: true,
        separatorSymbol: "#",
        numberDigits: 3,
        symbolPosition: "after",
        capitalize: "every",
      };
    });
    const code = settingsCode(heavy, config) as string;
    assert.deepEqual(readSettingsCode(code, config), { ok: true, settings: heavy });
    assert.ok(code.length <= 70, code);
    // Known answers pin the format: a code once given out keeps its meaning.
    assert.equal(code, "PG1-0GC2-80MX-1581-NJGR-0K8Y-E01W-5805-224J-KF8J-P5P6-A7NX-VJQ8");
    t.diagnostic(`defaults: PG1-ZW (6 characters); heavily customised: ${code} (${code.length} characters)`);
  });
});

describe("check characters", () => {
  const sample = validSettings(4, 60).map((s) => settingsCode(s, config) as string);
  sample.push("PG1-ZW");

  test("every single changed character is caught, in every position of every sampled code", () => {
    let tried = 0;
    for (const code of sample) {
      const chars = [...charsOf(code)];
      for (const [i, original] of chars.entries()) {
        for (const replacement of ALPHABET) {
          if (replacement === original) continue;
          const typo = [...chars];
          typo[i] = replacement;
          assert.deepEqual(decodeSettingsCode(`PG1-${typo.join("")}`), { ok: false, error: "checksum" }, code);
          tried += 1;
        }
      }
    }
    assert.ok(tried > 10_000, `tried ${tried}`);
  });

  test("every swap of two adjacent different characters is caught", () => {
    let tried = 0;
    for (const code of sample) {
      const chars = [...charsOf(code)];
      for (let i = 0; i + 1 < chars.length; i += 1) {
        if (chars[i] === chars[i + 1]) continue;
        const typo = [...chars];
        [typo[i], typo[i + 1]] = [typo[i + 1] as string, typo[i] as string];
        assert.deepEqual(decodeSettingsCode(`PG1-${typo.join("")}`), { ok: false, error: "checksum" }, code);
        tried += 1;
      }
    }
    assert.ok(tried > 300, `tried ${tried}`);
  });
});

describe("refused codes", () => {
  const refuse = (text: unknown, error: string, page: Config = config) =>
    assert.deepEqual(readSettingsCode(text, page), { ok: false, error }, String(text));

  test("empty, not text, or too long", () => {
    refuse("", "empty");
    refuse("   ", "empty");
    refuse(undefined, "format");
    refuse(42, "format");
    refuse(`PG1-${"0".repeat(300)}`, "format");
  });

  test("a missing or wrong prefix, or characters outside the alphabet", () => {
    refuse("ZW", "format");
    refuse("PG-ZW", "format");
    refuse("PGI-ZW", "format");
    refuse("XX1-ZW", "format");
    refuse("PG1ZW", "format");
    refuse("PG1-", "format");
    refuse("PG1-Z", "format");
    refuse("PG1-ZU", "format");
    refuse("PG1-Z*", "format");
    refuse("PG1-ŹW", "format");
  });

  test("a changed character fails the check", () => {
    refuse("PG1-ZX", "checksum");
    refuse("PG1-WZ", "checksum");
  });

  test("another version, or a field, list or style number this version does not know, is a newer version", () => {
    refuse("PG2-ZW", "version");
    refuse("PG0-ZW", "version");
    refuse("PG10-ZW", "version");
    for (const number of [29, 30, 31]) refuse(craft(field(number)), "version");
    for (const index of [5, 6]) refuse(craft(field(1) + bin(index, 3)), "version");
    for (const index of [5, 6, 7]) refuse(craft(field(18) + bin(index, 3)), "version");
  });

  test("malformed bodies: values outside their lists, repeated or unordered fields, restated baselines, bad padding, cut-off entries", () => {
    refuse(craft(field(0) + bin(3, 2)), "format"); // theme 3
    refuse(craft(field(27) + bin(3, 2)), "format"); // symbol position 3
    refuse(craft(field(28) + bin(3, 2)), "format"); // capitalize 3
    for (const value of [2, 32, 127]) refuse(craft(field(25) + bin(value, 7)), "format"); // separator
    refuse(craft(field(5) + field(5)), "format"); // repeated switch
    refuse(craft(field(5) + field(3)), "format"); // out of order
    refuse(craft(field(2) + bin(20, 8)), "format"); // length restating the baseline
    refuse(craft(field(0) + bin(0, 2)), "format"); // theme restating the baseline
    refuse(craft(field(1) + bin(0, 3)), "format"); // calm restated
    refuse(craft(field(1) + bin(7, 3) + bin(3, 5) + [2, 0, 11, 12].map((c) => bin(c, 6)).join("")), "format"); // "calm" spelled out
    refuse(craft(field(1) + bin(7, 3) + bin(0, 5) + bin(40, 6)), "format"); // style letter outside the alphabet
    refuse(craft(field(2) + bin(2, 4)), "format"); // cut off
    refuse(craft(`${field(0)}${bin(2, 2)}1`), "format"); // non-zero padding
    // Sanity: the same crafting gives accepted codes when the content is right.
    assert.equal(readSettingsCode(craft(field(5)), config).ok, true);
    assert.equal(readSettingsCode(craft(field(0) + bin(2, 2)), config).ok, true);
  });

  test("values the stored-settings validator refuses are refused here too", () => {
    const len = (n: number) => craft(field(2) + bin(n, 8));
    refuse(len(3), "unavailable");
    refuse(len(129), "unavailable");
    refuse(len(255), "unavailable");
    refuse(craft(field(19) + bin(13, 4)), "unavailable"); // 13 words
    refuse(craft(field(19) + bin(1, 4)), "unavailable"); // 1 word
    refuse(craft(field(26) + bin(0, 2)), "unavailable"); // 0 digits
    refuse(craft(field(10) + bin(21, 8)), "unavailable"); // Min above the length
    refuse(craft(field(10) + bin(5, 8) + field(11) + bin(4, 8)), "unavailable"); // Min above Max
    refuse(craft(field(10) + bin(10, 8) + field(12) + bin(11, 8)), "unavailable"); // Mins exceed the length
    refuse(craft(field(6)), "unavailable"); // Complex without Simple
    refuse(craft(field(3) + field(4) + field(5) + field(6) + field(7)), "unavailable"); // no types
    refuse(craft(field(20) + bin(2, 4)), "unavailable"); // word length below the list
    refuse(craft(field(18) + bin(3, 3) + field(21) + bin(9, 4)), "unavailable"); // above eff-short1's 5
    refuse(craft(field(20) + bin(9, 4) + field(21) + bin(8, 4)), "unavailable"); // Min above Max
    refuse(craft(field(25) + bin("&".charCodeAt(0), 7)), "unavailable"); // a Complex symbol as separator
    refuse(craft(field(25) + bin("a".charCodeAt(0), 7)), "unavailable");
    refuse(craft(field(1) + bin(7, 3) + bin(3, 5) + [13, 4, 14, 13].map((c) => bin(c, 6)).join("")), "unavailable"); // "neon"
  });

  test("a word list or style this page does not offer is refused", () => {
    const narrow: Config = structuredClone(config);
    (narrow.passphrase.wordLists as { offered: unknown[] }).offered = narrow.passphrase.wordLists.offered.filter(
      (list) => list.id !== "eff-large",
    );
    (narrow.style as { offered: unknown[] }).offered = narrow.style.offered.filter((style) => style.id !== "purple");
    const list = settingsCode(
      edited((s) => Object.assign(s.passphrase, { wordList: "eff-large", maxWordLength: 9 })),
      config,
    );
    const style = settingsCode(
      edited((s) => Object.assign(s, { style: "purple" })),
      config,
    );
    refuse(list, "unavailable", narrow);
    refuse(style, "unavailable", narrow);
    assert.equal(readSettingsCode(list, config).ok, true);
    assert.equal(readSettingsCode(style, config).ok, true);
  });
});

describe("making a code", () => {
  test("settings that could not be saved give no code", () => {
    const midEdit = edited((s) => {
      s.password.counts.lowercase.min = Number.NaN;
    });
    assert.equal(settingsCode(midEdit, config), null);
    const minAboveMax = edited((s) => {
      s.password.counts.numbers = { min: 5, max: 4 };
    });
    assert.equal(settingsCode(minAboveMax, config), null);
  });

  test("a value this version cannot express throws rather than meaning something else", () => {
    assert.throws(() => encodeSettingsCode({ ...BASELINE, theme: "sepia" }), RangeError);
    assert.throws(() => encodeSettingsCode({ ...BASELINE, style: "Calm2" }), RangeError);
    assert.throws(
      () => encodeSettingsCode({ ...BASELINE, password: { ...BASELINE.password, length: 256 } }),
      RangeError,
    );
  });
});

describe("no generated value", () => {
  test("neither the code nor any message contains a password or passphrase made with its settings", () => {
    const messages = [
      CODE_HINT,
      CODE_READY_STATUS,
      CODE_INVALID_STATUS,
      CODE_APPLIED_STATUS,
      ...Object.values(CODE_ERROR_STATUS),
    ].map((m) => m.toUpperCase());
    for (const settings of validSettings(5, 200)) {
      const code = settingsCode(settings, config) as string;
      const outputs = [generatePassphrase(settings.passphrase)];
      try {
        outputs.push(generatePassword(settings.password, config.password));
      } catch {}
      for (const output of outputs) {
        const value = output.toUpperCase();
        assert.ok(!code.toUpperCase().includes(value), "the code contains a generated value");
        assert.ok(!charsOf(code).includes(value.replaceAll("-", "")));
        for (const message of messages) assert.ok(!message.includes(value));
      }
      // The code is the same whatever was generated: it is made from settings alone.
      assert.equal(settingsCode(settings, config), code);
    }
  });
});
