/**
 * Copy text, with a fallback for non-secure contexts.
 *
 * navigator.clipboard only exists in a secure context — localhost qualifies, a
 * LAN IP over plain http does not, which is exactly how this app gets tested on
 * a real phone. The same gotcha message-composer already guards against for
 * crypto.randomUUID.
 *
 * Returns whether it worked, so the caller can say so rather than silently
 * doing nothing.
 */
export async function copyText(text: string): Promise<boolean> {
  if (!text) return false;

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied, or not user-initiated. Fall through.
    }
  }

  try {
    const area = document.createElement("textarea");
    area.value = text;
    // Off-screen rather than hidden: display:none and visibility:hidden both
    // make the selection fail, and a readOnly field still stops the mobile
    // keyboard appearing for the instant it is focused.
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-9999px";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
