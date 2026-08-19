import { NextResponse } from "next/server";
import { isCronAuthorized } from "@/lib/jobs/cron-auth";
import { runAccountAnonymizer } from "@/lib/jobs/anonymize-accounts";
import { logServerError } from "@/lib/log";

// Nightly account anonymizer (Docs/user/profile.md — Delete Account: "Nightly
// job anonymizes the profile"; README "Deferred background jobs"). Invoked by
// Vercel Cron (web/vercel.json) as GET with `Authorization: Bearer CRON_SECRET`;
// fails closed when the env var is unset. Also sweeps expired reserved_username
// rows — this job is the sanctioned writer, the public availability read path
// must never write.
export const runtime = "nodejs"; // Cloudinary SDK + node:crypto
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  try {
    const report = await runAccountAnonymizer();
    return NextResponse.json({ ok: true, ...report });
  } catch (err) {
    logServerError("cron:anonymize-accounts", err);
    return NextResponse.json({ error: "Job failed" }, { status: 500 });
  }
}
