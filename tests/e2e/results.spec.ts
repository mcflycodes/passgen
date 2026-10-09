import { AxeBuilder } from "@axe-core/playwright";
import { config } from "../../src/config/validate.ts";
import { expect, test } from "./fixtures.ts";
import { openPage, setNumber } from "./helpers.ts";

for (const [prefix, kind] of [
  ["pw", "password"],
  ["pp", "passphrase"],
] as const) {
  test(`${kind}: configured extra count, same settings, regeneration and keyboard copying`, async ({
    page,
    context,
  }) => {
    if (test.info().project.name.includes("chrom")) await context.grantPermissions(["clipboard-write"]);
    await page.addInitScript(() => {
      const writes: string[] = [];
      Object.assign(window, { clipboardWrites: writes });
      const write = navigator.clipboard.writeText.bind(navigator.clipboard);
      Object.defineProperty(navigator.clipboard, "writeText", {
        value: async (value: string) => {
          await write(value);
          writes.push(value);
        },
      });
    });
    await openPage(page);
    const extras = page.locator(`#${prefix}-more-list output`);
    await expect(extras).toHaveCount(config.extraResults);
    await expect(page.locator(`#${prefix}-more`)).toBeVisible();
    const original = await extras.allTextContents();
    await page.locator(`#${prefix}-regen`).click();
    expect(await extras.allTextContents()).not.toEqual(original);
    if (prefix === "pw") {
      await setNumber(page.locator("#pw-length-number"), 32);
      for (const value of await extras.allTextContents()) expect(value).toHaveLength(32);
      for (const id of ["pw-uppercase", "pw-numbers", "pw-simple"]) await page.locator(`#${id}`).uncheck();
      for (const value of await extras.allTextContents()) expect(value).toMatch(/^[a-z]{32}$/);
    } else {
      await page.locator("#pp-number").uncheck();
      await page.locator("#pp-symbol-char").selectOption("_");
      await setNumber(page.locator("#pp-words-number"), 3);
      for (const value of await extras.allTextContents()) expect(value).toMatch(/^[a-z]+_[a-z]+_[a-z]+$/);
    }
    const outputs = page.locator(`#${prefix}-value, #${prefix}-more-list output`);
    for (const output of await outputs.all()) await expect(output).toHaveAttribute("data-generated", "");
    for (let index = 0; index <= config.extraResults; index += 1) {
      const name = index === 0 ? `main ${kind}` : `${kind} result ${index}`;
      const button =
        index === 0
          ? page.locator(`#${prefix}-copy`)
          : page
              .locator(`#${prefix}-more-list li`)
              .nth(index - 1)
              .locator("button")
              .first();
      await expect(button).toHaveAccessibleName(`Copy ${name}`);
      const value = await outputs.nth(index).textContent();
      await button.focus();
      await page.keyboard.press(index % 2 === 0 ? "Enter" : "Space");
      await expect(button).toHaveText("Copied");
      await expect(button).toHaveAccessibleName(`Copied: ${name}`);
      await expect(page.getByRole("status").filter({ hasText: `${name} copied.` })).toHaveCount(1);
      expect(
        await page.evaluate(() => (window as unknown as { clipboardWrites: string[] }).clipboardWrites.at(-1)),
      ).toBe(value);
    }
    await expect(page.locator(`#${prefix}-copy`)).toHaveText("Copy", { timeout: 5000 });
    await expect(page.locator(`#${prefix}-more-list li`).last().locator("button").first()).toHaveText("Copy", {
      timeout: 5000,
    });
    // Copy feedback has no operation that clears the actual clipboard.
    const writes = await page.evaluate(() => (window as unknown as { clipboardWrites: string[] }).clipboardWrites);
    expect(writes).toHaveLength(config.extraResults + 1);
    expect(writes.at(-1)).toBe(await outputs.last().textContent());
    expect(await page.locator("dialog[open], [role=dialog], [role=alert]").count()).toBe(0);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}

test("invalid settings clear extras and copy feedback, recovery produces fresh results", async ({ page, context }) => {
  if (test.info().project.name.includes("chrom")) await context.grantPermissions(["clipboard-write"]);
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-02T00:00:00Z"));
  await openPage(page);
  await page.locator("#pw-copy").click();
  await expect(page.locator("#pw-copy")).toHaveText("Copied");
  await setNumber(page.locator("#pw-lowercase-min"), 21);
  await expect(page.locator("#pw-more-list output")).toHaveCount(0);
  await expect(page.locator("#pw-more")).toBeHidden();
  await expect(page.locator("#pw-value")).toHaveText("");
  await expect(page.locator("#pw-copy")).toBeDisabled();
  expect(await page.locator("#pw-copy").textContent()).toBe("Copy");
  await setNumber(page.locator("#pw-lowercase-min"), 1);
  await expect(page.locator("#pw-more-list output")).toHaveCount(config.extraResults);
});

for (const mode of ["unavailable", "rejected"] as const) {
  test(`clipboard ${mode}: inline guidance and keyboard text selection for main and extra results`, async ({
    page,
  }) => {
    await page.addInitScript((mode) => {
      Object.defineProperty(navigator, "clipboard", {
        value:
          mode === "unavailable"
            ? undefined
            : {
                writeText: async () => {
                  throw new Error("private clipboard failure");
                },
              },
      });
    }, mode);
    await openPage(page);
    for (const [prefix, kind] of [
      ["pw", "password"],
      ["pp", "passphrase"],
    ]) {
      for (const name of [`main ${kind}`, `${kind} result 1`]) {
        const button = name.startsWith("main")
          ? page.locator(`#${prefix}-copy`)
          : page.locator(`#${prefix}-more-list li`).first().locator("button").first();
        await expect(button).toHaveAccessibleName(`Copy ${name}`);
        await button.focus();
        await page.keyboard.press("Enter");
        await expect(button).toHaveText("Copy failed");
        await expect(button).toHaveAccessibleName(`Copy failed: ${name}`);
        await expect(page.getByRole("status").filter({ hasText: `Copy failed for ${name}.` })).toBeVisible();
        const select = page.getByRole("button", { name: `Select ${name} text`, exact: true });
        expect(await select.evaluate((button) => button.closest('[role="status"], [aria-live]'))).toBeNull();
        const id = name.startsWith("main") ? `${prefix}-value` : `${prefix}-extra-1`;
        const output = page.locator(`#${id}`);
        const tabIndex = await output.getAttribute("tabindex");
        await select.focus();
        await page.keyboard.press("Enter");
        expect(await output.getAttribute("tabindex")).toBe(tabIndex);
        expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
          await page.locator(`#${id}`).textContent(),
        );
      }
    }
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}

test("late clipboard response cannot mark a replacement result as copied", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-02T00:00:00Z"));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: () =>
          new Promise<void>((resolve) => {
            Object.assign(window, { finishCopy: resolve });
          }),
      },
    });
  });
  await openPage(page);
  await page.locator("#pw-copy").click();
  await page.locator("#pw-regen").click();
  await page.evaluate(() => (window as unknown as { finishCopy: () => void }).finishCopy());
  expect(await page.locator("#pw-copy").textContent()).toBe("Copy");
  expect(await page.locator("#password .is-copied").count()).toBe(0);
});

test("generation and copying never leak results into storage, location, history or console", async ({
  page,
  context,
}) => {
  await page.addInitScript(() => {
    const writes: [string, string][] = [];
    Object.assign(window, { storageWrites: writes });
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      writes.push([key, value]);
      setItem.call(this, key, value);
    };
  });
  const consoleMessages: string[] = [];
  page.on("console", (message) => consoleMessages.push(message.text()));
  page.on("pageerror", (error) => consoleMessages.push(error.message));
  if (test.info().project.name.includes("chrom")) await context.grantPermissions(["clipboard-write"]);
  await openPage(page);
  const url = page.url();
  const historyLength = await page.evaluate(() => history.length);
  const values = new Set<string>();
  const collect = async () => {
    for (const value of await page.locator("[data-generated]").allTextContents()) values.add(value);
  };
  for (let session = 0; session < 3; session += 1) {
    await collect();
    for (const prefix of ["pw", "pp"]) {
      await page.locator(`#${prefix}-copy`).click();
      await page.locator(`#${prefix}-more-list button`).first().click();
      await page.locator(`#${prefix}-regen`).click();
      await collect();
    }
    await setNumber(page.locator("#pw-length-number"), 24 + session);
    await collect();
    await setNumber(page.locator("#pp-words-number"), 6 + session);
    await collect();
  }
  const state = await page.evaluate(() => ({
    writes: (window as unknown as { storageWrites: [string, string][] }).storageWrites,
    local: Object.entries(localStorage),
    session: Object.entries(sessionStorage),
    location: location.href,
    history: JSON.stringify(history.state),
    length: history.length,
  }));
  expect(state.location).toBe(url);
  expect(state.length).toBe(historyLength);
  // Saving is off in this session; no storage entry, including a settings key, is expected.
  expect(state.writes).toEqual([]);
  expect(state.local).toEqual([]);
  expect(state.session).toEqual([]);
  for (const value of values) {
    expect(value).not.toBe("");
    for (const surface of [
      JSON.stringify(state.local),
      JSON.stringify(state.session),
      state.location,
      state.history,
      ...consoleMessages,
    ]) {
      expect(surface).not.toContain(value);
      expect(surface).not.toContain(encodeURIComponent(value));
      expect(surface).not.toContain(JSON.stringify(value).slice(1, -1));
      expect(surface).not.toContain(Buffer.from(value).toString("base64"));
      expect(surface).not.toContain(Buffer.from(value).toString("hex"));
    }
  }
});

test("generation failure clears both panels without retaining extra values", async ({ page }) => {
  await openPage(page);
  await page.evaluate(() => {
    Object.defineProperty(crypto, "getRandomValues", {
      value: () => {
        throw new Error("random source unavailable");
      },
    });
  });
  for (const prefix of ["pw", "pp"]) {
    await page.locator(`#${prefix}-regen`).click();
    await expect(page.locator(`#${prefix}-value`)).toHaveText("");
    await expect(page.locator(`#${prefix}-more-list output`)).toHaveCount(0);
    await expect(page.locator(`#${prefix}-more`)).toBeHidden();
    await expect(page.locator(`#${prefix}-copy`)).toBeDisabled();
  }
});

test("replaced extra results release feedback, listeners and pending copy requests", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-01-01T00:00:00Z") });
  await page.clock.pauseAt(new Date("2026-01-02T00:00:00Z"));
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: () =>
          new Promise<void>((resolve) => {
            const state = window as unknown as { writes: number; finishCopy: () => void };
            state.writes = (state.writes ?? 0) + 1;
            state.finishCopy = resolve;
          }),
      },
    });
  });
  await openPage(page);
  await page.evaluate(() => {
    const row = document.querySelector("#pw-more-list li") as HTMLLIElement;
    Object.assign(window, {
      oldResult: {
        row,
        button: row.querySelector("button"),
        status: row.querySelector('[role="status"]'),
      },
    });
  });
  await page.locator("#pw-more-list li button").first().click();
  await page.locator("#pw-regen").click();
  const released = await page.evaluate(async () => {
    const state = window as unknown as {
      finishCopy: () => void;
      writes: number;
      oldResult: { row: HTMLLIElement; button: HTMLButtonElement; status: HTMLElement };
    };
    state.finishCopy();
    await Promise.resolve();
    await Promise.resolve();
    const text = state.oldResult.button.textContent;
    const statusRemoved = !state.oldResult.row.contains(state.oldResult.status);
    state.oldResult.button.click();
    return { text, statusRemoved, writes: state.writes };
  });
  expect(released).toEqual({ text: "Copy", statusRemoved: true, writes: 1 });
});
