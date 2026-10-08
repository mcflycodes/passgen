import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../../src/config/validate.ts";
import { createResultsBox } from "../../src/ui/results.ts";

// A small DOM double exercises the real rendering and copy binding without a browser.
class Element extends EventTarget {
  children: Element[] = [];
  parentElement: Element | null = null;
  textContent = "";
  className = "";
  id = "";
  hidden = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  classList = { remove() {} };
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  getAttribute(key: string) {
    return this.attributes.get(key) ?? null;
  }
  append(...children: Element[]) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren() {
    this.children = [];
  }
  remove() {
    if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
  }
}

for (const count of [2, 7]) {
  test(`results use configured count ${count} rather than a fixed count`, (t) => {
    const section = new Element();
    const list = new Element();
    const globals = {
      HTMLElement: Element,
      HTMLUListElement: Element,
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
      document: {
        getElementById: (id: string) => (id === "pw-more" ? section : list),
        createElement: () => new Element(),
      },
    };
    const descriptors = new Map(
      Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
    );
    const originalCount = config.extraResults;
    t.after(() => {
      config.extraResults = originalCount;
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    });
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, { configurable: true, value });
    config.extraResults = count;
    const requests: number[] = [];
    const box = createResultsBox("pw");
    box.render((requested) => {
      requests.push(requested);
      return Array.from({ length: requested }, (_, index) => `value ${index}`);
    });
    assert.deepEqual(requests, [count]);
    assert.equal(list.children.length, count);
    assert.equal(section.hidden, false);
    assert.deepEqual(
      list.children.map((row) => row.children[0]?.textContent),
      Array.from({ length: count }, (_, index) => `value ${index}`),
    );
    box.render(() => []);
  });
}
