import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfigJson } from "../../scripts/lib/config-json.ts";
import config from "../../src/config/config.json" with { type: "json" };
import { type Config, SIMPLE_HAZARDS, validateConfig } from "../../src/config/validate.ts";

test("shipped configuration passes without mutation", () => {
  const copy = structuredClone(config);
  validateConfig(copy);
  assert.deepEqual(copy, config);
});

test("shipped look-alike set is exactly the eight R7a characters", () => {
  assert.deepEqual([...config.password.lookAlikes].sort(), [..."lIO01|`'"].sort());
});
test("shipped symbol classes are exactly the R7 sets: 12 Simple, 20 Complex", () => {
  const { simple, complex } = config.password.characters;
  assert.deepEqual([...simple].sort(), [..."!@#$^*()-_.?"].sort());
  assert.deepEqual([...complex].sort(), [..."\"'`\\/|<>[]{}:;,~&%+="].sort());
  assert.equal(SIMPLE_HAZARDS, "'\"<>;\\&%=+");
  for (const char of SIMPLE_HAZARDS) assert.ok(complex.includes(char), `hazard ${char} belongs to Complex`);
});
test("excluding look-alikes with every class on leaves 86 of 94 characters", () => {
  const all = Object.values(config.password.characters).join("");
  assert.equal(all.length, 94);
  const copy = structuredClone(config);
  copy.password.excludeLookAlikes = true;
  copy.password.enabled = { lowercase: true, uppercase: true, numbers: true, simple: true, complex: true };
  validateConfig(copy);
  const pool = [...all].filter((char) => !copy.password.lookAlikes.includes(char));
  assert.equal(pool.length, 86);
});

// Each fixture changes one invariant and checks its diagnostic.
const cases: [string, string, unknown, RegExp][] = [
  ["unknown root", "unknown", true, /unknown key/],
  ["unknown nested", "password.length.unknown", 1, /unknown key/],
  ["unknown band", "meter.bands.0.unknown", 1, /unknown key/],
  ["missing", "password.length.default", undefined, /missing key/],
  ["missing nested object", "password", undefined, /missing key/],
  ["wrong string", "theme", 1, /expected string/],
  ["wrong boolean", "text.intro.enabled", "false", /expected boolean/],
  ["http link", "links.repoUrl", "http://example.invalid/passgen", /https URL or empty/],
  ["javascript link", "links.licenseUrl", "javascript:alert(1)", /https URL or empty/],
  ["relative link", "links.licenseUrl", "./LICENSE", /https URL or empty/],
  ["scheme-relative link", "links.repoUrl", "//example.invalid/passgen", /https URL or empty/],
  ["link without a host", "links.repoUrl", "https:///path", /https URL or empty|normalised form/],
  ["link with credentials", "links.repoUrl", "https://user:pw@example.invalid/", /credentials/],
  ["link with spaces", "links.repoUrl", "https://example.invalid/a b", /normalised form/],
  ["link with an upper-case host", "links.repoUrl", "https://Example.invalid/", /normalised form/],
  ["link with no path written out", "links.repoUrl", "https://example.invalid", /normalised form/],
  ["link too long", "links.repoUrl", `https://example.invalid/${"a".repeat(200)}`, /at most 200/],
  ["link of the wrong type", "links.repoUrl", null, /expected string/],
  ["missing links", "links", undefined, /missing key/],
  ["wrong number", "extraResults", "5", /expected number/],
  ["wrong object", "password", [], /expected object/],
  ["null object", "password", null, /expected object/],
  ["wrong array", "meter.bands", {}, /expected array/],
  ["zero rate", "meter.attacks.bcrypt.guessesPerSecond", 0, /positive/],
  ["wrong Argon2id tag size", "meter.attacks.argon2id.tagBytes", 31, /32/],
  [
    "tag length not disclosed",
    "meter.attacks.argon2id.parameters",
    "64 MiB memory, 3 iterations, parallelism 1",
    /tag length/,
  ],
  ["negative slow rate", "meter.attacks.argon2id.guessesPerSecond", -1, /positive/],
  ["missing hash parameters", "meter.attacks.argon2id.parameters", "", /assumptions/],
  ["empty lockout", "meter.attacks.online.lockout", " ", /assumptions/],
  ["online attempts too high", "meter.attacks.online.attempts", 101, /integer/],
  ["zero online attempts", "meter.attacks.online.attempts", 0, /integer/],
  ["unsafe warning floor", "meter.passphraseWarningBits", 79, /integer/],
  ["zero quantum iteration", "meter.quantum.future.iterationSeconds", 0, /positive/],
  ["zero quantum processors", "meter.quantum.future.processors", 0, /integer/],
  ["empty quantum assumptions", "meter.quantum.future.assumptions", "", /assumptions/],
  ["nonfinite", "extraResults", Infinity, /finite/],
  ["NaN", "extraResults", NaN, /finite/],
  ["fractional", "extraResults", 1.5, /integer/],
  ["negative count", "extraResults", -1, /integer/],
  ["unsafe count", "extraResults", Number.MAX_SAFE_INTEGER + 1, /integer/],
  ["theme", "theme", "automatic", /unsupported/],
  ["no styles", "style.offered", [], /at least one style/],
  ["style id with capitals", "style.offered.0.id", "Calm", /lowercase name/],
  ["style id with a slash", "style.offered.0.id", "../calm", /lowercase name/],
  ["duplicate style", "style.offered.1.id", "calm", /duplicate style/],
  ["empty style label", "style.offered.0.label", " ", /must not be empty/],
  ["long style label", "style.offered.0.label", "x".repeat(25), /at most 24/],
  ["default style not offered", "style.default", "ghost", /one of the offered styles/],
  ["unknown style key", "style.offered.0.author", "x", /unknown key/],
  ["tagline over its cap", "text.tagline", "x".repeat(81), /at most 80 characters/],
  ["headline over its cap", "text.intro.headline", "x".repeat(61), /at most 60 characters/],
  ["intro text over its cap", "text.intro.text", "x".repeat(241), /at most 240 characters/],
  ["tagline with a newline", "text.tagline", "a\nb", /control characters/],
  ["headline with a control character", "text.intro.headline", "a\u0007b", /control characters/],
  ["text with a paragraph separator", "text.intro.text", "a\u2029b", /control characters/],
  ["enabled intro without a headline", "text.intro.headline", "", /needs a headline/],
  ["enabled intro without text", "text.intro.text", " ", /needs a headline/],
  ["intro enabled not a boolean", "text.intro.enabled", "yes", /expected boolean/],
  ["password minimum", "password.length.min", 3, /integer/],
  ["password maximum", "password.length.max", 129, /integer/],
  ["reversed bounds", "password.length.max", 3, /integer/],
  ["default below min", "password.length.default", 3, /integer/],
  ["default above max", "password.length.default", 129, /integer/],
  ["weak password", "password.length.default", 4, /80 bits/],
  ["word minimum", "passphrase.words.min", 1, /integer/],
  ["word maximum", "passphrase.words.max", 13, /integer/],
  ["weak passphrase", "passphrase.words.default", 2, /80 bits/],
  ["short word limit", "passphrase.wordLength.min", 2, /integer/],
  ["long word limit", "passphrase.wordLength.max", 10, /integer/],
  ["filter default below range", "passphrase.wordLength.defaultMin", 2, /integer/],
  ["filter default above range", "passphrase.wordLength.defaultMax", 10, /integer/],
  ["filter inverted", "passphrase.wordLength.defaultMax", 4, /integer/],
  ["unconfirmed count", "passphrase.defaultFilteredWordCount", 7776, /unknown key/],
  ["negative minimum count", "password.counts.numbers.min", -1, /integer/],
  ["fractional minimum count", "password.counts.numbers.min", 0.5, /integer/],
  ["minimum count above the longest length", "password.counts.numbers.min", 129, /integer/],
  ["maximum count below its minimum", "password.counts.numbers.max", 0, /integer/],
  ["maximum count above the longest length", "password.counts.numbers.max", 129, /integer/],
  ["maximum count not a number or null", "password.counts.numbers.max", "20", /expected number/],
  ["minimum count null", "password.counts.numbers.min", null, /expected number/],
  ["minimum counts exceed the shortest length", "password.counts.lowercase.min", 2, /minimum counts/],
  ["empty class", "password.characters.simple", "", /empty/],
  ["duplicate class", "password.characters.simple", "!!", /duplicate/],
  ["overlap", "password.characters.simple", "!a", /overlapping/],
  ["space", "password.characters.simple", "! ", /ASCII/],
  ["combining accent", "password.characters.simple", "!\u0301", /ASCII/],
  ["full-width punctuation", "password.characters.simple", "!！", /ASCII/],
  ["digit overlap", "password.characters.simple", "!7", /overlapping/],
  ["nonascii", "password.characters.simple", "!é", /ASCII/],
  ["wrong class", "password.characters.simple", "!B", /overlapping/],
  ["empty exclusions", "password.lookAlikes", "", /empty/],
  ["duplicate exclusions", "password.lookAlikes", "ll", /duplicate/],
  ["foreign exclusions", "password.lookAlikes", "é", /belong/],
  ["exclusions empty class", "password.lookAlikes", config.password.characters.lowercase, /empties/],
  ["complex without simple", "password.enabled.simple", false, /Complex implies/],
  [
    "no classes",
    "password.enabled",
    { lowercase: false, uppercase: false, numbers: false, simple: false, complex: false },
    /at least one/,
  ],
  ["separator empty", "passphrase.separator.defaultSymbol", "", /one simple/],
  ["separator multiple", "passphrase.separator.defaultSymbol", "--", /one simple/],
  ["separator complex", "passphrase.separator.defaultSymbol", "~", /one simple/],
  ["separator hazard", "passphrase.separator.defaultSymbol", "+", /one simple/],
  ["separator minimum", "passphrase.separator.numberMin", 1, /00–99/],
  ["separator maximum", "passphrase.separator.numberMax", 100, /00–99/],
  ["separator width", "passphrase.separator.numberDigits", 1, /00–99/],
  ["missing band", "meter.bands", config.meter.bands.slice(1), /R17/],
  ["inflated meter", "meter.bands.3.minBits", 79, /integer/],
  ["wrong band label", "meter.bands.3.label", "Excellent", /R17/],
  ["hash", "meter.attacks.fast.hash", "bcrypt", /NTLM/],
  ["gpu count", "meter.attacks.fast.gpus", 1, /8 GPUs/],
  ["slow headline", "meter.attacks.fast.guessesPerSecond", 1, /2.4e12/],
  ["keyspace fraction", "meter.attacks.fast.averageKeyspaceFraction", 1, /half/],
  ["bcrypt cost", "meter.attacks.bcrypt.cost", 11, /cost 12/],
  ["quantum wording", "meter.quantum.current", "quantum-safe", /approved quantum/],
  ["invalid future estimate", "meter.quantum.future", "one second", /expected object/],
];
for (const [name, path, value, message] of cases) {
  test(`rejects ${name}`, () => {
    const copy: unknown = structuredClone(config);
    const keys = path.split(".");
    let target = copy as Record<string, unknown>;
    for (const key of keys.slice(0, -1)) target = target[key] as Record<string, unknown>;
    const key = keys.at(-1) as string;
    if (value === undefined) delete target[key];
    else target[key] = value;
    assert.throws(() => validateConfig(copy), message);
  });
}

// Move letters and digits into symbols without overlap: ASCII class validation
// must still refuse them after the original class no longer contains them.
for (const [name, character] of [
  ["lowercase", "a"],
  ["uppercase", "B"],
  ["numbers", "7"],
] as const) {
  test(`rejects ${name} moved into symbols without overlap`, () => {
    const copy = structuredClone(config);
    copy.password.characters[name] = copy.password.characters[name].replace(character, "");
    copy.password.characters.simple += character;
    assert.throws(() => validateConfig(copy), /password.characters.simple:.*ASCII/);
  });
}

// Moving any injection or parsing hazard from Complex into Simple fails the
// build (R7), even though the character is otherwise valid printable ASCII.
for (const hazard of SIMPLE_HAZARDS)
  test(`rejects hazard ${JSON.stringify(hazard)} in Simple`, () => {
    const copy = structuredClone(config);
    copy.password.characters.simple += hazard;
    copy.password.characters.complex = copy.password.characters.complex.replace(hazard, "");
    assert.throws(() => validateConfig(copy), /hazards reserved for Complex/);
  });
test("accepts an empty tagline, a disabled intro with empty text, and a single offered style", () => {
  const copy = structuredClone(config);
  copy.text.tagline = "";
  copy.text.intro = { enabled: false, headline: "", text: "" };
  copy.style.offered = [{ id: "payload", label: "Payload" }];
  copy.style.default = "payload";
  validateConfig(copy);
});
test("caps count code points, not UTF-16 units", () => {
  const copy = structuredClone(config);
  copy.text.tagline = "\u{1F512}".repeat(80);
  validateConfig(copy);
  copy.text.tagline = "\u{1F512}".repeat(81);
  assert.throws(() => validateConfig(copy), /at most 80/);
});
test("accepts every hazard in Complex and any other punctuation in Simple", () => {
  const copy = structuredClone(config);
  copy.password.characters.simple = "!@#$^*()-_.?/|[]{}:,~`";
  copy.password.characters.complex = SIMPLE_HAZARDS;
  copy.password.lookAlikes = "lIO01`";
  validateConfig(copy);
});
// Space and non-ASCII characters are never used in any class (R7).
for (const name of Object.keys(config.password.characters))
  for (const [label, extra] of [
    ["space", " "],
    ["accented letter", "é"],
    ["currency sign", "€"],
    ["emoji", "😀"],
    ["non-breaking space", "\u00a0"],
  ] as const)
    test(`rejects ${label} in ${name}`, () => {
      const copy = structuredClone(config);
      const characters = copy.password.characters as Record<string, string>;
      characters[name] = `${characters[name]}${extra}`;
      assert.throws(() => validateConfig(copy), /ASCII/);
    });

function recordPaths(value: unknown, path = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return [path, ...Object.entries(value).flatMap(([key, child]) => recordPaths(child, path ? `${path}.${key}` : key))];
}
function atPath(value: unknown, path: string): Record<string, unknown> {
  let node = value as Record<string, unknown>;
  for (const key of path.split(".").filter(Boolean)) node = node[key] as Record<string, unknown>;
  return node;
}
for (const path of recordPaths(config)) {
  test(`rejects unknown keys at ${path || "root"}`, () => {
    const copy = structuredClone(config);
    atPath(copy, path).unexpected = true;
    assert.throws(() => validateConfig(copy), /unknown key/);
  });
  for (const key of Object.keys(atPath(config, path))) {
    test(`rejects missing ${path ? `${path}.` : ""}${key}`, () => {
      const copy = structuredClone(config);
      delete atPath(copy, path)[key];
      assert.throws(() => validateConfig(copy), /missing key/);
    });
  }
}

test("rejects sparse band arrays", () => {
  const copy = structuredClone(config);
  copy.meter.bands = new Array(6);
  assert.throws(() => validateConfig(copy), /expected object/);
});
test("rejects unknown array properties", () => {
  const copy = structuredClone(config);
  Object.assign(copy.meter.bands, { unexpected: true });
  assert.throws(() => validateConfig(copy), /unknown key/);
});

test("accepts stricter meter thresholds", () => {
  const copy = structuredClone(config);
  atPath(copy, "meter.bands.3").minBits = 81;
  validateConfig(copy);
});
test("rejects unordered meter thresholds", () => {
  const copy = structuredClone(config);
  atPath(copy, "meter.bands.1").minBits = 80;
  assert.throws(() => validateConfig(copy), /ordered/);
});
test("rejects defaults below a stricter Strong threshold", () => {
  const copy = structuredClone(config);
  atPath(copy, "meter.bands.3").minBits = 100;
  assert.throws(() => validateConfig(copy), /configured Strong/);
});

test("rejects maximum counts that together fall short of the default length", () => {
  const copy: Config = structuredClone(config);
  for (const name of ["lowercase", "uppercase", "numbers", "symbols"] as const)
    copy.password.counts[name] = { min: 1, max: 4 };
  assert.throws(() => validateConfig(copy), /cover the default length/);
  copy.password.counts.lowercase = { min: 1, max: 8 };
  validateConfig(copy);
});
test("accepts count defaults that fit every length, and the exact count decides the 80-bit check", () => {
  const copy: Config = structuredClone(config);
  copy.password.counts.numbers = { min: 0, max: 3 };
  copy.password.counts.symbols = { min: 1, max: 1 };
  validateConfig(copy);
  // A Max of 1 on symbols, numbers, uppercase: 17 lowercase letters and three
  // forced characters still exceed 80 bits (26^17 alone is about 2^79.9).
  copy.password.counts.uppercase = { min: 1, max: 1 };
  copy.password.counts.numbers = { min: 1, max: 1 };
  validateConfig(copy);
});
test("rejects count defaults whose exact count falls below 80 bits", () => {
  // Every class enabled but only digits allowed to appear: 10^20 passwords, about 2^66.
  const copy: Config = structuredClone(config);
  copy.password.counts.lowercase = { min: 0, max: 0 };
  copy.password.counts.uppercase = { min: 0, max: 0 };
  copy.password.counts.symbols = { min: 0, max: 0 };
  assert.throws(() => validateConfig(copy), /80 bits/);
  // Letting one more class in brings it back above the bar.
  copy.password.counts.lowercase = { min: 0, max: null };
  validateConfig(copy);
});
test("rejects a maximum count below its minimum", () => {
  const copy: Config = structuredClone(config);
  copy.password.counts.lowercase = { min: 4, max: 3 };
  assert.throws(() => validateConfig(copy), /integer/);
});
test("a disabled class may carry any valid count defaults", () => {
  const copy: Config = structuredClone(config);
  copy.password.enabled.complex = false;
  copy.password.enabled.simple = false;
  copy.password.counts.symbols = { min: 20, max: 20 };
  validateConfig(copy);
});

test("accepts a different default filter using its real count", () => {
  const copy = structuredClone(config);
  copy.passphrase.wordLength.defaultMin = 6;
  validateConfig(copy);
});
test("rejects a narrow default filter whose computed count is too weak", () => {
  const copy = structuredClone(config);
  copy.passphrase.wordLength.defaultMin = 9;
  assert.throws(() => validateConfig(copy), /80 bits/);
});

for (const [name, minimum] of Object.entries({ lowercase: 20, uppercase: 20, numbers: 8, simple: 8, complex: 8 })) {
  test(`rejects ${name} below its minimum size`, () => {
    const copy = structuredClone(config);
    const classes = copy.password.characters as Record<string, string>;
    classes[name] = (classes[name] as string).slice(0, minimum - 1);
    copy.password.lookAlikes = [...copy.password.lookAlikes]
      .filter((char) => Object.values(classes).join("").includes(char))
      .join("");
    assert.throws(() => validateConfig(copy), new RegExp(`requires at least ${minimum} characters`));
  });
}
test("ASCII diagnostic precedes duplicate diagnostic for surrogate pairs", () => {
  const copy = structuredClone(config);
  copy.password.characters.simple += "😀😀";
  assert.throws(() => validateConfig(copy), /ASCII/);
});
for (const source of [
  '{"theme":1,"theme":2}',
  '{"password":{"characters":{"simple":1,"simple":2}}}',
  '[{"x":1,"x":2}]',
  '{"theme":1,"th\\u0065me":2}',
  '{"__proto__":1,"__proto__":2}',
]) {
  test(`rejects duplicate keys in ${source}`, () => {
    assert.throws(() => parseConfigJson(source), /duplicate JSON key/);
  });
}
test("JSON reader accepts sibling keys, escaped strings and nested arrays", () => {
  const source = JSON.stringify({ a: [{ x: 'quote" and comma, braces{}' }, { x: 2 }], b: { x: null } });
  assert.deepEqual(parseConfigJson(source), JSON.parse(source));
});
test("JSON reader retains strict JSON grammar", () => {
  for (const source of ['{"x":1,}', '{"x":undefined}', '{"x":1} garbage'])
    assert.throws(() => parseConfigJson(source), SyntaxError);
});

test("accepts sets at every minimum size", () => {
  const copy = structuredClone(config);
  Object.assign(copy.password.characters, {
    lowercase: copy.password.characters.lowercase.slice(0, 20),
    uppercase: copy.password.characters.uppercase.slice(0, 20),
    numbers: copy.password.characters.numbers.slice(0, 8),
    simple: "!@#$^*()-",
    complex: copy.password.characters.complex.slice(0, 8),
  });
  copy.password.characters.simple = copy.password.characters.simple.replace("^", "");
  copy.passphrase.words.max = 9;
  validateConfig(copy);
});

test("extra results accepts the maximum of 20", () => {
  const copy = structuredClone(config);
  copy.extraResults = 20;
  validateConfig(copy);
});

test("extra results rejects 21", () => {
  const copy = structuredClone(config);
  copy.extraResults = 21;
  assert.throws(() => validateConfig(copy), /extraResults.*integer.*20/);
});
