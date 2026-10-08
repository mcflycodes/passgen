// Clipboard contents are left to the user: browsers cannot reliably auto-clear
// them (R23). Feedback never includes the generated value or a browser error.
const FEEDBACK_MS = 1500;

export async function writeClipboard(
  value: string,
  clipboard: Pick<Clipboard, "writeText"> | undefined,
): Promise<boolean> {
  try {
    if (!clipboard) return false;
    await clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

/** Binds one result's Copy button; the returned cleanup releases its handlers. */
export function bindCopy(button: HTMLButtonElement, read: () => string, output: HTMLOutputElement): () => void {
  const label = button.textContent;
  const name = button.getAttribute("aria-label") ?? "Copy result";
  const description = name.replace(/^Copy /, "");
  const status = document.createElement("span");
  status.className = "sr-only";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const message = document.createElement("span");
  const select = document.createElement("button");
  select.type = "button";
  select.className = "chip";
  select.textContent = "Select text";
  select.setAttribute("aria-label", `Select ${description} text`);
  select.hidden = true;
  select.addEventListener("click", () => {
    const tabIndex = output.getAttribute("tabindex");
    output.tabIndex = -1;
    output.focus();
    if (tabIndex === null) output.removeAttribute("tabindex");
    else output.setAttribute("tabindex", tabIndex);
    const range = document.createRange();
    range.selectNodeContents(output);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  status.append(message);
  button.parentElement?.append(status, select);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0;
  const reset = () => {
    revision += 1;
    clearTimeout(timer);
    button.textContent = label;
    button.setAttribute("aria-label", name);
    button.classList.remove("is-copied");
    message.textContent = "";
    status.className = "sr-only";
    select.hidden = true;
  };
  const observer = new MutationObserver(reset);
  observer.observe(output, { childList: true, characterData: true, subtree: true });
  const copy = async () => {
    if (button.disabled) return;
    const value = read();
    if (value === "") return;
    reset();
    const request = revision;
    const copied = await writeClipboard(value, navigator.clipboard);
    if (request !== revision || read() !== value) return;
    const feedback = copied ? "Copied" : "Copy failed";
    button.textContent = feedback;
    button.setAttribute("aria-label", `${feedback}: ${description}`);
    button.classList.toggle("is-copied", copied);
    message.textContent = copied
      ? `${description} copied.`
      : `Copy failed for ${description}. Select the text and copy it manually. `;
    status.className = copied ? "sr-only" : "copy-feedback";
    select.hidden = copied;
    // Failure guidance stays available until another attempt or a new result.
    timer = setTimeout(() => {
      button.textContent = label;
      button.setAttribute("aria-label", name);
      button.classList.remove("is-copied");
      if (copied) message.textContent = "";
    }, FEEDBACK_MS);
  };
  button.addEventListener("click", copy);
  return () => {
    reset();
    observer.disconnect();
    button.removeEventListener("click", copy);
    status.remove();
    select.remove();
  };
}
