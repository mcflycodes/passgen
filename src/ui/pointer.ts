// The shared, opt-in pointer effect for decorative backgrounds (R4c). It only
// writes CSS custom properties on <html>:
//
//   --px / --py     pointer position as a percentage of the viewport (raw)
//   --pxs / --pys   the same, eased (fast)
//   --pxt / --pyt   the same, eased (slow trail)
//   --pxn / --pyn   eased position as plain numbers 0 to 1, for calc() in angles
//
// A style opts in with `--fx-follow: 1` and shapes the look in its own tokens;
// `--fx-rest-x` and `--fx-rest-y` are where the layers sit at rest. The effect
// is off under prefers-reduced-motion, without a hover-capable fine pointer
// (touch-only devices) and while the tab is hidden, and it follows those
// settings live. At most one update per animation frame, passive listeners,
// no layout reads per frame. `refresh` re-reads the tokens after a style change.

const PROPS = ["--px", "--py", "--pxs", "--pys", "--pxt", "--pyt", "--pxn", "--pyn"] as const;
const FAST = 0.16;
const SLOW = 0.05;
const SETTLED = 0.0005;

export interface PointerEffect {
  /** Re-reads --fx-follow and the rest position from the current style. */
  refresh(): void;
  /** Whether the effect is currently writing properties. */
  readonly active: boolean;
}

/** A number held to 0..1; anything unreadable becomes `fallback` (itself held to 0..1). */
export function clampUnit(value: number, fallback: number): number {
  const safe = Number.isFinite(value) ? value : fallback;
  return Math.min(1, Math.max(0, Number.isFinite(safe) ? safe : 0));
}

export function startPointerEffect(): PointerEffect {
  const root = document.documentElement;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  const pointer = matchMedia("(hover: hover) and (pointer: fine)");

  let optedIn = false;
  let restX = 0.5;
  let restY = 0.3;
  let width = window.innerWidth;
  let height = window.innerHeight;
  let targetX = restX;
  let targetY = restY;
  let fastX = restX;
  let fastY = restY;
  let slowX = restX;
  let slowY = restY;
  let frame = 0;
  let enabled = false;

  const readTokens = () => {
    const style = getComputedStyle(root);
    // Rest positions come from a style's tokens: held to 0..1 whatever they say.
    const token = (name: string, fallback: number) =>
      clampUnit(Number.parseFloat(style.getPropertyValue(name)), fallback);
    optedIn = style.getPropertyValue("--fx-follow").trim() === "1";
    restX = token("--fx-rest-x", 0.5);
    restY = token("--fx-rest-y", 0.3);
  };
  // Every written value is held to its bounds at write time: 0% to 100% and 0 to 1.
  const percent = (n: number) => `${(clampUnit(n, 0) * 100).toFixed(2)}%`;
  const unit = (n: number) => clampUnit(n, 0).toFixed(4);
  const write = () => {
    const s = root.style;
    s.setProperty("--px", percent(targetX));
    s.setProperty("--py", percent(targetY));
    s.setProperty("--pxs", percent(fastX));
    s.setProperty("--pys", percent(fastY));
    s.setProperty("--pxt", percent(slowX));
    s.setProperty("--pyt", percent(slowY));
    s.setProperty("--pxn", unit(fastX));
    s.setProperty("--pyn", unit(fastY));
  };
  const tick = () => {
    frame = 0;
    fastX += (targetX - fastX) * FAST;
    fastY += (targetY - fastY) * FAST;
    slowX += (targetX - slowX) * SLOW;
    slowY += (targetY - slowY) * SLOW;
    write();
    const far =
      Math.abs(targetX - slowX) + Math.abs(targetY - slowY) + Math.abs(targetX - fastX) + Math.abs(targetY - fastY);
    if (far > SETTLED) frame = requestAnimationFrame(tick);
  };
  const onMove = (event: PointerEvent) => {
    targetX = Math.min(1, Math.max(0, event.clientX / width));
    targetY = Math.min(1, Math.max(0, event.clientY / height));
    if (!frame) frame = requestAnimationFrame(tick);
  };
  const onResize = () => {
    width = window.innerWidth;
    height = window.innerHeight;
  };
  const clear = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    for (const prop of PROPS) root.style.removeProperty(prop);
    // Leave no empty style attribute behind: the page carries inline style
    // only while the effect is writing it.
    if (root.style.length === 0) root.removeAttribute("style");
    targetX = fastX = slowX = restX;
    targetY = fastY = slowY = restY;
  };
  const update = () => {
    const want = optedIn && pointer.matches && !motion.matches && !document.hidden;
    if (want === enabled) return;
    enabled = want;
    if (enabled) {
      window.addEventListener("pointermove", onMove, { passive: true });
      window.addEventListener("resize", onResize, { passive: true });
    } else {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("resize", onResize);
      clear();
    }
  };
  const refresh = () => {
    const wasEnabled = enabled;
    readTokens();
    // A new style has its own rest position: start it from rest.
    if (wasEnabled) clear();
    update();
  };

  motion.addEventListener("change", update);
  pointer.addEventListener("change", update);
  document.addEventListener("visibilitychange", update);
  readTokens();
  update();

  return {
    refresh,
    get active() {
      return enabled;
    },
  };
}
