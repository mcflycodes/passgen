/** Size a text slot using an invisible exemplar in the same grid cell.
 * The real content can always grow; nothing is clipped or taken out of flow.
 * Exemplars are excluded from the accessibility tree and contain no results.
 */
export function reserveText(element: HTMLElement, texts: readonly string[]): void {
  const slot = document.createElement("div");
  slot.className = "reserved-text";
  const sizing = document.createElement(element.tagName);
  sizing.className = `${element.className} reserved-text-sizing`;
  sizing.setAttribute("aria-hidden", "true");
  if (element.tagName === "DIV") {
    for (const text of texts) {
      const paragraph = document.createElement("p");
      paragraph.textContent = text;
      sizing.append(paragraph);
    }
  } else {
    sizing.textContent = texts.join(" ");
  }
  element.before(slot);
  slot.append(element, sizing);
}
