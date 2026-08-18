import { useCallback, useSyncExternalStore } from "react";

/**
 * Notification display preferences — toasts, sound, tab-title blink.
 *
 * localStorage, NOT the database, and that is a considered call rather than the
 * lazy one. These three are client *display* preferences, exactly like theme:
 * they are per-device by nature (sound on the desktop, silence on the work
 * laptop), the server never reads them, and a database round trip would mean
 * the first toast after load fires before the preference has arrived.
 *
 * The counter-precedent — every other settings page here is DB-backed — does
 * not apply. Privacy, profile and username are all read BY THE SERVER on behalf
 * of other users. These are read by nobody but this browser.
 *
 * Per-conversation MUTE is the exception and lives in the database
 * (conversation_member.muted_until), because it has to hold across every device
 * and is a property of the conversation rather than of this screen.
 *
 * Same useSyncExternalStore-over-localStorage shape as theme-provider.tsx, for
 * the same reason: subscribing means the first client render already shows the
 * stored value, where an effect would render the default once and then correct
 * itself — a visible flicker on every switch in the settings page.
 */

export type NotificationPrefs = {
  toasts: boolean;
  sound: boolean;
  titleBlink: boolean;
};

export const NOTIFICATION_STORAGE_KEY = "chatsphere-notifications";

// Everything on. A messenger that silently notifies you of nothing until you
// find the settings page is a broken messenger.
export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  toasts: true,
  sound: true,
  titleBlink: true,
};

const PREFS_EVENT = "chatsphere-notifications-change";

// One frozen object, returned whenever the stored value is absent or unusable.
// getSnapshot must be referentially stable between calls or React throws
// "The result of getSnapshot should be cached to avoid an infinite loop".
const DEFAULTS = Object.freeze({ ...DEFAULT_NOTIFICATION_PREFS });

// Parsing on every getSnapshot would return a fresh object each time and hit
// that same error, so the parsed value is cached against the raw string.
let cachedRaw: string | null = null;
let cachedValue: NotificationPrefs = DEFAULTS;

function readPrefs(): NotificationPrefs {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(NOTIFICATION_STORAGE_KEY);
  } catch {
    // Private-mode Safari throws on localStorage access. Defaults are correct.
    return DEFAULTS;
  }
  if (raw === cachedRaw) return cachedValue;
  cachedRaw = raw;
  cachedValue = parse(raw);
  return cachedValue;
}

function parse(raw: string | null): NotificationPrefs {
  if (!raw) return DEFAULTS;
  try {
    const parsed = JSON.parse(raw) as Partial<NotificationPrefs>;
    // Key by key, so a stored value written by an older version that lacks a
    // key gets the default for it rather than `undefined`.
    return {
      toasts: parsed.toasts ?? DEFAULTS.toasts,
      sound: parsed.sound ?? DEFAULTS.sound,
      titleBlink: parsed.titleBlink ?? DEFAULTS.titleBlink,
    };
  } catch {
    return DEFAULTS;
  }
}

function subscribe(onChange: () => void) {
  window.addEventListener(PREFS_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PREFS_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

/**
 * Read outside React — used by realtime-provider's socket handlers, which run
 * from listeners registered once and must not close over a stale value.
 */
export function getNotificationPrefs(): NotificationPrefs {
  if (typeof window === "undefined") return DEFAULTS;
  return readPrefs();
}

export function useNotificationPrefs(): {
  prefs: NotificationPrefs;
  setPref: <K extends keyof NotificationPrefs>(key: K, value: NotificationPrefs[K]) => void;
} {
  const prefs = useSyncExternalStore(subscribe, readPrefs, () => DEFAULTS);

  const setPref = useCallback(
    <K extends keyof NotificationPrefs>(key: K, value: NotificationPrefs[K]) => {
      const next = { ...getNotificationPrefs(), [key]: value };
      try {
        localStorage.setItem(NOTIFICATION_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Nothing useful to do — the switch simply won't persist.
      }
      // `storage` only fires in OTHER tabs, so this one is notified explicitly.
      window.dispatchEvent(new Event(PREFS_EVENT));
    },
    [],
  );

  return { prefs, setPref };
}
