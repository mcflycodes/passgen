import assert from "node:assert/strict";
import { test } from "node:test";
import { needsFocusScroll } from "../../src/ui/focus.ts";

for (const [name, keyboard, ring, visible, expected] of [
  ["visible ring", true, { top: 100, bottom: 140 }, { top: 72, bottom: 800 }, false],
  ["exact boundaries", true, { top: 72, bottom: 800 }, { top: 72, bottom: 800 }, false],
  ["ring under sticky header", true, { top: 71.5, bottom: 140 }, { top: 72, bottom: 800 }, true],
  ["ring below viewport", true, { top: 760, bottom: 803.5 }, { top: 72, bottom: 800 }, true],
  ["smaller visual viewport", true, { top: 600, bottom: 716.9 }, { top: 0, bottom: 659 }, true],
  ["shifted visual viewport", true, { top: 49, bottom: 100 }, { top: 50, bottom: 650 }, true],
  ["pointer focus below viewport", false, { top: 760, bottom: 804 }, { top: 72, bottom: 800 }, false],
  ["pointer focus under header", false, { top: 60, bottom: 100 }, { top: 72, bottom: 800 }, false],
] as const) {
  test(`focus scroll decision: ${name}`, () => {
    assert.equal(needsFocusScroll(keyboard, ring, visible), expected);
  });
}
