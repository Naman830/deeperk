/**
 * Tab-title blink (Docs/chat/chat.md §6, the layer that fires only when the tab
 * is hidden).
 *
 * The trap: app/layout.tsx sets `title.template`, and Next rewrites
 * document.title on every client navigation and on router.refresh(). A blinker
 * that captured the base title once and kept restoring it will fight that and
 * can leave the tab permanently reading "(3) New messages". So the base is
 * captured at the *start* of each burst, and stopBlink() must be called on
 * navigation as well as on visibilitychange.
 */

let baseTitle: string | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

const BLINK_MS = 1500;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function startBlink(count: number): void {
  if (typeof document === "undefined") return;
  if (baseTitle === null) baseTitle = document.title;

  const label = `(${count > 99 ? "99+" : count}) New message${count === 1 ? "" : "s"}`;
  if (timer) clearInterval(timer);
  document.title = label;

  // Reduced motion still gets the count, just without the flashing.
  if (prefersReducedMotion()) return;

  let showingBase = false;
  timer = setInterval(() => {
    showingBase = !showingBase;
    document.title = showingBase && baseTitle !== null ? baseTitle : label;
  }, BLINK_MS);
}

export function stopBlink(): void {
  if (typeof document === "undefined") return;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (baseTitle !== null) {
    document.title = baseTitle;
    baseTitle = null;
  }
}

/** Called on navigation: drop the captured base without clobbering the title
 *  Next has just written. */
export function forgetBlinkBase(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  baseTitle = null;
}
