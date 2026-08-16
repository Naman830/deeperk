"use client";

import { useEffect, useState } from "react";

// Delays reflecting `value` until it's stayed unchanged for `delayMs` — used
// for live checks (e.g. username availability) that shouldn't fire on every keystroke.
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);

  return debounced;
}
