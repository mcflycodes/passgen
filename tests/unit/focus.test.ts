import assert from "node:assert/strict";
import { test } from "node:test";
import { focusScrollDelta, needsFocusScroll } from "../../src/ui/focus.ts";

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

for (const [name, ring, visible, expected] of [
  ["visible ring", { top: 100, bottom: 140 }, { top: 72, bottom: 800 }, 0],
  ["exact boundaries", { top: 72, bottom: 800 }, { top: 72, bottom: 800 }, 0],
  ["ring partly under the pinned header", { top: -22, bottom: 18 }, { top: 53, bottom: 640 }, -75],
  ["ring wholly above the viewport", { top: -300, bottom: -260 }, { top: 53, bottom: 640 }, -353],
  ["ring partly below the viewport", { top: 620, bottom: 660 }, { top: 53, bottom: 640 }, 20],
  [
    "ring taller than the visible area keeps its top in view",
    { top: 300, bottom: 1000 },
    { top: 53, bottom: 640 },
    247,
  ],
] as const) {
  test(`focus scroll distance: ${name}`, () => {
    assert.equal(focusScrollDelta(ring, visible), expected);
  });
}
