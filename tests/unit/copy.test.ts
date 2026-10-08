import assert from "node:assert/strict";
import { test } from "node:test";
import { writeClipboard } from "../../src/ui/copy.ts";

test("clipboard success writes exactly once without clearing afterwards", async () => {
  const writes: string[] = [];
  assert.equal(
    await writeClipboard("test value", {
      writeText: async (value) => {
        writes.push(value);
      },
    }),
    true,
  );
  assert.deepEqual(writes, ["test value"]);
});

test("clipboard absence is an inline failure outcome", async () => {
  assert.equal(await writeClipboard("test value", undefined), false);
});

test("clipboard rejection does not expose the exception", async () => {
  assert.equal(
    await writeClipboard("test value", {
      writeText: async () => {
        throw new Error("private browser error");
      },
    }),
    false,
  );
});
