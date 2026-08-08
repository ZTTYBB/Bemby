/**
 * Puts text on the clipboard, wherever the panel is being viewed from.
 *
 * `navigator.clipboard` exists only in a secure context, so on a panel reached over plain HTTP
 * at a LAN address the whole object is undefined -- not a rejected promise, which is why
 * reaching straight for `.writeText` throws "Cannot read properties of undefined". The old
 * `execCommand` route still works there, so it stands in.
 *
 * Returns whether the text made it, so a caller can say so plainly rather than surfacing a
 * TypeError. A browser that refuses both leaves the text uncopied and nothing thrown.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through: a permission the user declined, or a context that only looks secure */
  }

  try {
    const el = document.createElement("textarea");
    el.value = text;
    // Off-screen but focusable: a hidden or detached field cannot be selected, and a field
    // that scrolls the page into view is worse than the copy it performs
    el.style.position = "fixed";
    el.style.top = "0";
    el.style.opacity = "0";
    el.setAttribute("readonly", "");
    document.body.appendChild(el);
    el.select();
    el.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}
