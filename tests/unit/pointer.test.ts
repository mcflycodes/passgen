import assert from "node:assert/strict";
import { test } from "node:test";
import { clampUnit } from "../../src/ui/pointer.ts";

test("pointer values are held to 0..1 at write time, whatever a style's rest tokens say", () => {
  assert.equal(clampUnit(999, 0.5), 1);
  assert.equal(clampUnit(-5, 0.5), 0);
  assert.equal(clampUnit(0.25, 0.5), 0.25);
  assert.equal(clampUnit(Number.NaN, 0.3), 0.3);
  assert.equal(clampUnit(Number.NaN, 7), 1);
  assert.equal(clampUnit(Number.POSITIVE_INFINITY, 0.3), 0.3);
  assert.equal(clampUnit(1, 0), 1);
  assert.equal(clampUnit(0, 1), 0);
});
