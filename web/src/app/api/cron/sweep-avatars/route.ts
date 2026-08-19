import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/jobs/cron-auth";
import { runAvatarSweep } from "@/lib/jobs/sweep-avatars";
import { CloudinaryNotConfiguredError } from "@/lib/integrations/cloudinary";
import { logServerError } from "@/lib/log";

// Nightly orphaned-avatar sweep (Docs/user/profile.md §5 — "orphan swept by a
// nightly cleanup job"). Same CRON_SECRET gate as anonymize-accounts.
// `?recentCutoffHours=` overrides the in-flight-upload guard (clamped 0–168,
// default 24h) — it exists for the e2e spec, which can't backdate Cloudinary's
// created_at; secret-gated, so it adds no attack surface.
export const runtime = "nodejs"; // Cloudinary SDK
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const raw = new URL(request.url).searchParams.get("recentCutoffHours");
  let recentCutoffMs: number | undefined;
  if (raw !== null) {
    const hours = Number(raw);
    if (!Number.isFinite(hours)) {
      return NextResponse.json({ error: "Invalid request" }, { status: 400 });
    }
    recentCutoffMs = Math.min(Math.max(hours, 0), 168) * 60 * 60 * 1000;
  }

  try {
    const report = await runAvatarSweep({ recentCutoffMs });
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    if (err instanceof CloudinaryNotConfiguredError) {
      return NextResponse.json({ error: "Cloudinary is not configured" }, { status: 503 });
    }
    logServerError("cron:sweep-avatars", err);
    return NextResponse.json({ error: "Job failed" }, { status: 500 });
  }
}
