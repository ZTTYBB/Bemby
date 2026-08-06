// Microsoft Edge on Windows restores a minimised window the instant a History API call runs
// while the page is hidden, so the panel pops straight back up. vue-router 4.6 started saving
// the scroll position on `visibilitychange` (4.5.1 does not, which is why this only began
// biting on that upgrade), and upstream closed it as not planned, so the workaround lives here.
// See https://github.com/vuejs/router/issues/2644
// and https://wiki.4ading.com/vue/trouble/edge-minimize-problem/
//
// The router's call is recognised by what it writes, not by when it arrives: its snapshot
// passes no URL and differs from the state already on the entry only in `scroll`. Timing is
// not usable here -- Blink runs a microtask checkpoint between event listeners, so a flag
// raised in our own `visibilitychange` handler is already down again by the time the router's
// handler runs (which is why the first attempt at this stopped holding). Matching on content
// also leaves genuine navigation in a hidden tab -- an expired session sending the app to the
// login page, say -- free to update the address bar.

const IS_EDGE = /\bEdg\//.test(navigator.userAgent);

type ReplaceState = (data: unknown, unused: string, url?: string | URL | null) => void;

const isStateObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Is this `replaceState` nothing but vue-router's scroll snapshot of the entry already
 * showing? Anything that moves the address bar or changes the entry itself is not.
 */
export function isScrollSnapshot(
  next: unknown,
  current: unknown,
  url?: string | URL | null,
): boolean {
  if (url != null && String(url) !== window.location.href) return false;
  if (!isStateObject(next) || !isStateObject(current)) return false;
  const keys = new Set([...Object.keys(next), ...Object.keys(current)]);
  keys.delete("scroll");
  return [...keys].every(
    (k) => JSON.stringify(next[k]) === JSON.stringify(current[k]),
  );
}

/** Installs the workaround once at startup; a no-op on every browser but Edge. */
export function suppressEdgeMinimizeRestore(): void {
  if (!IS_EDGE) return;

  const original = history.replaceState.bind(history) as ReplaceState;
  const guarded: ReplaceState = (data, unused, url) => {
    if (
      document.visibilityState === "hidden" &&
      isScrollSnapshot(data, history.state, url)
    )
      return;
    original(data, unused, url);
  };
  history.replaceState = guarded as History["replaceState"];
}
