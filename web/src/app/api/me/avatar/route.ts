import sharp from "sharp";
import { NextResponse } from "next/server";
import { eq } from "@/lib/db/drizzle-ops";
import { db } from "@/lib/db";
import { user } from "../../../../../../db/schema";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { AVATAR_RULES } from "@/lib/validation/profile";
import { uploadImage, destroyImage, CloudinaryNotConfiguredError, AVATAR_FOLDER } from "@/lib/integrations/cloudinary";
import { sniffAvatarImage } from "@/lib/media/sniff";
import { avatarUrl } from "@/lib/avatar-url";
import { logServerError } from "@/lib/log";

export const runtime = "nodejs"; // sharp and the Cloudinary SDK need Node APIs

const UPLOAD_LIMIT = { windowSeconds: 60 * 60, max: 10 }; // 10/hour/user (Docs/user/profile.md §6)
const ENVELOPE_SLACK = 64 * 1024; // multipart boundary + headers on top of the file

// Avatar upload (Docs/user/profile.md §2 Avatar Upload, §4, §5, §6).
export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  if (!(request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
    return NextResponse.json({ error: "Expected a multipart/form-data upload" }, { status: 415 });
  }

  // Reject an oversized body from its header, before reading a single byte.
  const declaredLength = Number(request.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declaredLength) && declaredLength > AVATAR_RULES.maxBytes + ENVELOPE_SLACK) {
    return NextResponse.json({ error: "Image must be 5MB or smaller" }, { status: 413 });
  }

  // Gates formData parsing, sharp, and Cloudinary — all the expensive work.
  const withinLimit = await checkRateLimit(`avatar-upload:${userId}`, UPLOAD_LIMIT.windowSeconds, UPLOAD_LIMIT.max);
  if (!withinLimit) return NextResponse.json({ error: "Too many uploads. Please try again later." }, { status: 429 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("avatar");
  if (!(file instanceof File)) return NextResponse.json({ error: "No image provided" }, { status: 400 });
  if (file.size > AVATAR_RULES.maxBytes) {
    return NextResponse.json({ error: "Image must be 5MB or smaller" }, { status: 413 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  // Shared with chat media (lib/media/sniff.ts), but the avatar allowlist stays
  // narrower — widening chat's must never widen this one.
  if (!sniffAvatarImage(buffer)) {
    return NextResponse.json({ error: "Image must be a JPG, PNG, or WebP" }, { status: 400 });
  }

  // metadata() parses headers only and never decodes pixels, so a compressed
  // bomb costs nothing here. limitInputPixels still rejects header-honest ones.
  let metadata;
  try {
    metadata = await sharp(buffer, { limitInputPixels: AVATAR_RULES.maxPixels }).metadata();
  } catch {
    return NextResponse.json({ error: "That image couldn't be read" }, { status: 400 });
  }

  if (!(AVATAR_RULES.formats as readonly string[]).includes(metadata.format ?? "")) {
    return NextResponse.json({ error: "Image must be a JPG, PNG, or WebP" }, { status: 400 });
  }
  if ((metadata.pages ?? 1) > 1) {
    return NextResponse.json({ error: "Animated images aren't supported" }, { status: 400 });
  }
  // EXIF rotation can swap width/height — measure what the viewer will see.
  const width = metadata.autoOrient?.width ?? metadata.width ?? 0;
  const height = metadata.autoOrient?.height ?? metadata.height ?? 0;
  if (width < AVATAR_RULES.minDimension || height < AVATAR_RULES.minDimension) {
    return NextResponse.json({ error: "Image must be at least 200×200" }, { status: 400 });
  }

  let publicId: string;
  try {
    publicId = await uploadImage(buffer, { folder: AVATAR_FOLDER, ownerId: userId });
  } catch (err) {
    if (err instanceof CloudinaryNotConfiguredError) {
      return NextResponse.json({ error: "Avatar uploads aren't configured" }, { status: 503 });
    }
    // The client only ever sees the generic message, so without this the actual
    // cause is lost — a restricted API key answers 403 `missing permissions
    // (actions=["create"])`, which is indistinguishable from a transient outage
    // until you read it.
    logServerError("avatar:upload", err);
    return NextResponse.json({ error: "Upload failed. Please try again." }, { status: 502 });
  }

  const [current] = await db.select({ avatarPublicId: user.avatarPublicId }).from(user).where(eq(user.id, userId)).limit(1);
  await db.update(user).set({ avatarPublicId: publicId, updatedAt: new Date() }).where(eq(user.id, userId));

  // Orphan on failure is acceptable — the new avatar still shows (profile.md §5).
  if (current?.avatarPublicId && current.avatarPublicId !== publicId) {
    await destroyImage(current.avatarPublicId).catch((err) => logServerError("avatar:destroy-previous", err));
  }

  return NextResponse.json({ avatarPublicId: publicId, avatarUrl: avatarUrl(publicId) });
}

export async function DELETE() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  // Shares the upload bucket — this hits Cloudinary too, and §6 lists no
  // separate limit for removal.
  const withinLimit = await checkRateLimit(`avatar-upload:${userId}`, UPLOAD_LIMIT.windowSeconds, UPLOAD_LIMIT.max);
  if (!withinLimit) return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 });

  const [current] = await db.select({ avatarPublicId: user.avatarPublicId }).from(user).where(eq(user.id, userId)).limit(1);
  if (!current?.avatarPublicId) return NextResponse.json({ avatarPublicId: null, avatarUrl: null });

  // Clear the row first: a failed destroy must leave the user with no avatar
  // (a sweepable orphan), not a row pointing at a deleted asset — that would be
  // a permanently broken image no cleanup job can fix.
  await db.update(user).set({ avatarPublicId: null, updatedAt: new Date() }).where(eq(user.id, userId));
  await destroyImage(current.avatarPublicId).catch((err) => logServerError("avatar:destroy-on-remove", err));

  return NextResponse.json({ avatarPublicId: null, avatarUrl: null });
}
