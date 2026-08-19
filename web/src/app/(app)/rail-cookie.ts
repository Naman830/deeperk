// Shared by the server layout (reads it) and the client rail (writes it).
// Deliberately its own module with no "use client": the layout must be able to
// import the constant without pulling app-rail's client module graph in with it.
//
// A cookie rather than localStorage, unlike the theme. (app)/layout.tsx is
// already fully dynamic — it awaits getSession(), which reads headers() — so
// `await cookies()` costs nothing extra and lets the server emit the correct rail
// width in the first byte. localStorage can't do that: the server can't see it, so
// it would need a second render-blocking inline script beside THEME_INIT_SCRIPT.
// The theme only uses localStorage because the ROOT layout must stay static, and
// that constraint doesn't apply here. A theme mismatch is a colour flash; a rail
// mismatch is a layout shift on an h-dvh flex shell, which is worse.
export const RAIL_COOKIE = "deeperk-rail";

const COLLAPSED = "collapsed";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

export function isRailCollapsed(cookieValue: string | undefined): boolean {
  return cookieValue === COLLAPSED;
}

/**
 * Written from the client. Cookies can't be `.set()` during Server Component
 * render (only in a Server Function or Route Handler), and a plain document.cookie
 * write avoids a Server Action round-trip for what is purely a display preference.
 */
export function persistRailState(collapsed: boolean): void {
  const secure = window.location.protocol === "https:" ? "; secure" : "";
  document.cookie = `${RAIL_COOKIE}=${collapsed ? COLLAPSED : "expanded"}; path=/; max-age=${ONE_YEAR_SECONDS}; samesite=lax${secure}`;
}
