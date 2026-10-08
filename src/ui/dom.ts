// Small DOM helpers for the interface modules. Elements are looked up by id
// and checked for their type, so a markup change fails loudly at startup
// instead of silently doing nothing. Nothing here builds markup from strings:
// Trusted Types are enforced, so content is set with textContent only.

/** The element with `id`, which must be an instance of `type`. */
export function byId<T extends HTMLElement>(id: string, type: new () => T): T {
  const element = document.getElementById(id);
  if (!(element instanceof type)) throw new Error(`#${id} is missing or not a ${type.name}`);
  return element;
}

/** Reads a number input as an integer, or null when it is empty or not a whole number. */
export function integerValue(input: HTMLInputElement): number | null {
  const text = input.value.trim();
  if (!/^-?\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** Keeps a range input and a number input showing the same integer, clamped to the range's bounds. */
export function bindRangePair(
  range: HTMLInputElement,
  number: HTMLInputElement,
  onChange: (value: number) => void,
): { set(value: number): void } {
  const min = Number(range.min);
  const max = Number(range.max);
  const clamp = (value: number) => Math.min(max, Math.max(min, Math.round(value)));
  // The filled part of the track, as a percentage in the --fill custom
  // property on the input itself (the stylesheet draws it). Like the pointer
  // effect, this is the one inline property the live-DOM gate allows there.
  const paint = () => {
    const fraction = max > min ? (Number(range.value) - min) / (max - min) : 0;
    range.style.setProperty("--fill", `${(Math.min(1, Math.max(0, fraction)) * 100).toFixed(2)}%`);
  };
  const set = (value: number) => {
    const clamped = clamp(value);
    range.value = String(clamped);
    number.value = String(clamped);
    paint();
  };
  range.addEventListener("input", () => {
    number.value = range.value;
    paint();
    onChange(Number(range.value));
  });
  number.addEventListener("change", () => {
    const parsed = integerValue(number);
    const value = parsed === null ? Number(range.value) : clamp(parsed);
    set(value);
    onChange(value);
  });
  return { set };
}

/** A short description of a character class for its label: "a–z" for a contiguous run, else the characters. */
export function describeCharacters(characters: string): string {
  const chars = [...characters];
  const first = chars[0];
  const last = chars.at(-1);
  if (chars.length >= 3 && first !== undefined && last !== undefined) {
    const contiguous = chars.every((char, i) => char.codePointAt(0) === (first.codePointAt(0) as number) + i);
    if (contiguous) return `${first}–${last}`;
  }
  return chars.join(" ");
}
