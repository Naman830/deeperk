"use client";

import { createContext, useCallback, useContext, useEffect, useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";

export const THEME_STORAGE_KEY = "deeperk-theme";

// Runs before first paint (inlined in layout.tsx) so the app never flashes the
// wrong theme. Keep in sync with applyTheme below — this is the one place the
// logic is duplicated, because an inline script can't import anything.
export const THEME_INIT_SCRIPT = `(function(){try{var s=localStorage.getItem("${THEME_STORAGE_KEY}");var d=s==="light"?false:(s==="system"?!matchMedia("(prefers-color-scheme: light)").matches:true);document.documentElement.classList.toggle("dark",d);}catch(e){document.documentElement.classList.add("dark");}})();`;

function applyTheme(preference: ThemePreference) {
  const dark = preference === "system" ? !window.matchMedia("(prefers-color-scheme: light)").matches : preference === "dark";
  document.documentElement.classList.toggle("dark", dark);
}

// Dark is the app's designed look, so it's the fallback everywhere: here, in
// THEME_INIT_SCRIPT, and on the server where localStorage doesn't exist.
const DEFAULT_PREFERENCE: ThemePreference = "dark";

// Same-tab notification for setPreference; cross-tab arrives via `storage`.
const PREFERENCE_EVENT = "deeperk-theme-change";

function getStoredPreference(): ThemePreference {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : DEFAULT_PREFERENCE;
}

function subscribeToPreference(onChange: () => void) {
  window.addEventListener(PREFERENCE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PREFERENCE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

type ThemeContextValue = {
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  // localStorage is external state, so it's subscribed to rather than copied
  // into an effect — that keeps the very first client render already showing the
  // stored preference (an effect would render "dark" once and then correct
  // itself, flashing the wrong row in the Appearance picker).
  // getServerSnapshot returns the same default the inline script falls back to.
  const preference = useSyncExternalStore(subscribeToPreference, getStoredPreference, () => DEFAULT_PREFERENCE);

  useEffect(() => {
    applyTheme(preference);
    if (preference !== "system") return;

    // Only follow the OS while "system" is selected.
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [preference]);

  const setPreference = useCallback((next: ThemePreference) => {
    localStorage.setItem(THEME_STORAGE_KEY, next);
    // `storage` only fires in OTHER tabs, so this tab is notified explicitly.
    window.dispatchEvent(new Event(PREFERENCE_EVENT));
  }, []);

  return <ThemeContext value={{ preference, setPreference }}>{children}</ThemeContext>;
}

export function useTheme() {
  const context = useContext(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside ThemeProvider");
  return context;
}
