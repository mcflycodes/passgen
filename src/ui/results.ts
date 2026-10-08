// Both panels provide fresh generation from their current settings (R20, R21).
import { config } from "../config/validate.ts";
import { bindCopy } from "./copy.ts";
import { byId } from "./dom.ts";

export interface ResultsBox {
  render(generate: (count: number) => string[]): void;
}

export function createResultsBox(prefix: "pw" | "pp"): ResultsBox {
  const section = byId(`${prefix}-more`, HTMLElement);
  const list = byId(`${prefix}-more-list`, HTMLUListElement);
  const kind = prefix === "pw" ? "password" : "passphrase";
  let cleanups: (() => void)[] = [];
  return {
    render(generate) {
      // Clear first: even a thrown generation error must not retain old values.
      for (const cleanup of cleanups) cleanup();
      cleanups = [];
      section.hidden = true;
      list.replaceChildren();
      const values = config.extraResults === 0 ? [] : generate(config.extraResults);
      for (const [index, value] of values.entries()) {
        const row = document.createElement("li");
        const output = document.createElement("output");
        output.className = "value";
        output.id = `${prefix}-extra-${index + 1}`;
        output.dataset.generated = "";
        output.setAttribute("aria-live", "off");
        output.setAttribute("role", "note");
        output.setAttribute("aria-label", `Generated ${kind} result ${index + 1}`);
        output.textContent = value;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "chip";
        button.textContent = "Copy";
        button.setAttribute("aria-label", `Copy ${kind} result ${index + 1}`);
        row.append(output, button);
        cleanups.push(bindCopy(button, () => output.textContent ?? "", output));
        list.append(row);
      }
      section.hidden = values.length === 0;
    },
  };
}
