import type { CallKind, CallLiveStatus, CallTerminalStatus } from "./types";

/**
 * CALL bubble wording (Docs/call/call.md §2.5). The server writes a compact
 * JSON body once, at call end; the per-viewer wording (caller vs others) is
 * derived here from body + senderId === viewerId, so the 17-field wire
 * contract never grows a viewer-dependent field.
 */

export type ParsedCallBody = {
  status: CallTerminalStatus;
  kind: CallKind;
  /** Talk time in seconds — null for MISSED/REJECTED. */
  durationSec: number | null;
};

/** Strict parse — anything malformed renders as a plain "Call" notice, never throws. */
export function parseCallBody(body: string | null): ParsedCallBody | null {
  if (!body) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const { status, kind, durationSec } = raw as Record<string, unknown>;
  if (status !== "ENDED" && status !== "MISSED" && status !== "REJECTED") return null;
  if (kind !== "AUDIO" && kind !== "VIDEO") return null;
  const duration =
    typeof durationSec === "number" && Number.isFinite(durationSec) && durationSec >= 0
      ? Math.floor(durationSec)
      : null;
  return { status, kind, durationSec: duration };
}

/** m:ss under an hour, h:mm:ss above. */
export function formatCallDuration(totalSec: number): string {
  const sec = Math.max(0, Math.floor(totalSec));
  const hours = Math.floor(sec / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const seconds = sec % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** call.md §2.5's table: the caller and everyone else read different lines. */
export function callBubbleText(parsed: ParsedCallBody, isCaller: boolean): string {
  const kindWord = parsed.kind === "VIDEO" ? "video" : "audio";
  switch (parsed.status) {
    case "ENDED":
      return parsed.durationSec !== null ? `Call ended · ${formatCallDuration(parsed.durationSec)}` : "Call ended";
    case "MISSED":
      return isCaller ? "No answer" : `Missed ${kindWord} call`;
    case "REJECTED":
      return isCaller ? "Call declined" : `Missed ${kindWord} call`;
  }
}

/** One status line for the history surfaces (call-row, /calls/[id]): live
 *  calls read "Ongoing", terminal ones reuse the §2.5 bubble wording above so
 *  the two can never drift. */
export function callStatusText(
  status: CallLiveStatus | CallTerminalStatus,
  kind: CallKind,
  durationSec: number | null,
  isCaller: boolean,
): string {
  if (status === "RINGING" || status === "ONGOING") return "Ongoing";
  return callBubbleText({ status, kind, durationSec }, isCaller);
}

/** Viewer-neutral wording for sidebar previews, where there is no viewer role. */
export function callPreviewText(parsed: ParsedCallBody | null): string {
  if (!parsed) return "Call";
  if (parsed.status === "ENDED") return "Call ended";
  return parsed.kind === "VIDEO" ? "Missed video call" : "Missed audio call";
}
