import sharp from "sharp";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { checkRateLimit } from "@/lib/rate-limit";
import { getMembership } from "@/lib/chat/membership";
import { sniffMedia } from "@/lib/media/sniff";
import { MEDIA_RULES, MEDIA_MAX_BYTES, VOICE_NOTE_MAX_MS } from "@/lib/validation/chat";
import { AVATAR_RULES } from "@/lib/validation/profile";
import {
  uploadAsset,
  CloudinaryNotConfiguredError,
  CHAT_MEDIA_FOLDER,
  MESSAGE_RESOURCE_TYPE,
  destroyAsset,
} from "@/lib/integrations/cloudinary";
import { signMediaToken, MediaSigningNotConfiguredError, MEDIA_TOKEN_TTL_MS } from "@/lib/chat/media-token";
import { logServerError } from "@/lib/log";

export const runtime = "nodejs"; // sharp and the Cloudinary SDK need Node APIs

// Chat media (Docs/chat/chat.md §2.7, §8). Same pipeline as the avatar route,
// different bucket, wider allowlist.
const UPLOAD_LIMIT = { windowSeconds: 60, max: 10 }; // 10/minute/user (chat.md §7)
// Not in the doc: 10/min x 20MB bounds nothing on a daily Cloudinary bill.
const DAILY_LIMIT = { windowSeconds: 24 * 60 * 60, max: 100 };
const ENVELOPE_SLACK = 64 * 1024; // multipart boundary + headers on top of the file
// The recorder's 2-min cap is a setTimeout, so a legit cap-hit take can run a
// few hundred ms over — a slack-free bound would reject the recorder's own output.
const VOICE_NOTE_SLACK_MS = 2_000;

const MESSAGE_TYPE = { image: "IMAGE", video: "VIDEO", audio: "AUDIO", file: "FILE" } as const;

const SIZE_LABEL = { image: "5MB", video: "20MB", audio: "5MB", file: "10MB" } as const;

// Magic bytes cannot tell an audio-only webm/mp4 from a video in the same
// container, so a voice note declares itself via the `voice` form field and
// this map re-types the sniffed container. Allowlist: anything else marked
// voice (an image, a pdf) is rejected, and the worst a lie achieves is a video
// rendering inside an audio player — its soundtrack plays, nothing else.
const VOICE_MIME: Record<string, string> = {
  webm: "audio/webm",
  mp4: "audio/mp4",
  ogg: "audio/ogg",
};

export async function POST(request: Request) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  const userId = session.user.id;

  if (!(request.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
    return NextResponse.json({ error: "Expected a multipart/form-data upload" }, { status: 415 });
  }

  // Reject an oversized body from its header, before reading a single byte.
  // Note a chunked request carries no content-length, so this is a fast path
  // and not the real bound — the rate limits below are (see CLAUDE.md's edge
  // body-cap deployment note, which applies here exactly as it does to avatars).
  const declaredLength = Number(request.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declaredLength) && declaredLength > MEDIA_MAX_BYTES + ENVELOPE_SLACK) {
    return NextResponse.json({ error: "That file is too large" }, { status: 413 });
  }

  // Gates formData parsing, sharp and Cloudinary — all the expensive work.
  const withinLimit = await checkRateLimit(`chat-media:${userId}`, UPLOAD_LIMIT.windowSeconds, UPLOAD_LIMIT.max);
  if (!withinLimit) return NextResponse.json({ error: "Too many uploads. Please try again later." }, { status: 429 });
  const withinDaily = await checkRateLimit(`chat-media-daily:${userId}`, DAILY_LIMIT.windowSeconds, DAILY_LIMIT.max);
  if (!withinDaily) return NextResponse.json({ error: "Daily upload limit reached." }, { status: 429 });

  const form = await request.formData().catch(() => null);
  const conversationId = form?.get("conversationId");
  const file = form?.get("file");
  if (typeof conversationId !== "string" || !(file instanceof File)) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  // Membership before Cloudinary: you can't spend someone else's conversation's
  // storage, and "not a member" and "no such conversation" answer the same.
  const membership = await getMembership(conversationId, userId);
  if (!membership) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

  const buffer = Buffer.from(await file.arrayBuffer());
  let sniffed = sniffMedia(buffer);
  if (!sniffed) {
    return NextResponse.json({ error: "That file type isn't supported" }, { status: 400 });
  }

  // Voice-note intent — see VOICE_MIME above. Sniff still ran first: the
  // reclassification only ever narrows an already-allowlisted container.
  if (form?.get("voice") === "1") {
    const voiceMime = sniffed.kind === "audio" ? sniffed.mime : VOICE_MIME[sniffed.format];
    if (!voiceMime) {
      return NextResponse.json({ error: "That recording format isn't supported" }, { status: 400 });
    }
    sniffed = { kind: "audio", format: sniffed.format, mime: voiceMime };
  }

  const rules = MEDIA_RULES[sniffed.kind];
  if (file.size > rules.maxBytes) {
    return NextResponse.json({ error: `${sniffed.kind} must be ${SIZE_LABEL[sniffed.kind]} or smaller` }, { status: 413 });
  }

  // Only images go anywhere near libvips. Video and raw bytes are never handed
  // to sharp at all, which is strictly safer than the avatar path.
  // Intrinsic size, carried through the media token into message.mediaWidth /
  // mediaHeight so a bubble can reserve the right aspect box before the image
  // loads. metadata() was already being called and its dimensions thrown away —
  // this costs nothing new.
  let dimensions: { w: number; h: number } | null = null;
  if (sniffed.kind === "image") {
    try {
      const metadata = await sharp(buffer, { limitInputPixels: AVATAR_RULES.maxPixels }).metadata();
      if (metadata.format !== sniffed.format) {
        return NextResponse.json({ error: "That image couldn't be read" }, { status: 400 });
      }
      // autoOrient, not the raw width/height: a phone photo carries an EXIF
      // rotation, and the raw pair is pre-rotation — so a portrait shot would
      // reserve a landscape box and the layout would jump anyway.
      const { width, height } = metadata.autoOrient;
      if (width && height) dimensions = { w: width, h: height };
    } catch {
      return NextResponse.json({ error: "That image couldn't be read" }, { status: 400 });
    }
  }

  let uploaded: { publicId: string; url: string; durationMs: number | null };
  try {
    uploaded = await uploadAsset(buffer, {
      folder: CHAT_MEDIA_FOLDER,
      ownerId: conversationId,
      resourceType: MESSAGE_RESOURCE_TYPE[MESSAGE_TYPE[sniffed.kind]],
      // No incoming transformation: unlike an avatar there's no crop to bake in,
      // and re-encoding a 20MB video on upload is not something to do inline.
      transformation: [],
    });
  } catch (err) {
    if (err instanceof CloudinaryNotConfiguredError) {
      return NextResponse.json({ error: "Uploads aren't configured" }, { status: 503 });
    }
    // The client only sees the generic message, so without this the real cause
    // is lost — a restricted API key answers 403 `missing permissions
    // (actions=["create"])`, indistinguishable from an outage until you read it.
    logServerError("chat-media:upload", err);
    return NextResponse.json({ error: "Upload failed. Please try again." }, { status: 502 });
  }

  // Attacker-controlled: capped, and rendered as text by the client, never as markup.
  const name = (file.name || "file").slice(0, 120);

  // Voice notes only. Cloudinary's probe, not the client's stopwatch — and
  // deliberately not stored for VIDEO, where nothing renders it yet.
  const durationMs = sniffed.kind === "audio" ? uploaded.durationMs : null;

  // §2.7's 2-minute cap, enforced from the probe on every AUDIO upload (voice
  // intent or a picked .ogg alike) — the client's recorder cap is advisory.
  // A probe miss (null) passes: it must not break legit sends, and the 5MB
  // byte cap still bounds it. The asset is already stored, so a reject must
  // clean up — best-effort, same posture as the avatar route's deletes.
  if (durationMs !== null && durationMs > VOICE_NOTE_MAX_MS + VOICE_NOTE_SLACK_MS) {
    destroyAsset(uploaded.publicId, MESSAGE_RESOURCE_TYPE.AUDIO).catch((err) =>
      logServerError("chat-media:destroy", err),
    );
    return NextResponse.json({ error: "Voice messages can be up to 2 minutes" }, { status: 413 });
  }

  let mediaToken: string;
  try {
    mediaToken = signMediaToken({
      u: userId,
      c: conversationId,
      p: uploaded.publicId,
      url: uploaded.url,
      mime: sniffed.mime,
      size: file.size,
      name,
      t: MESSAGE_TYPE[sniffed.kind],
      w: dimensions?.w,
      h: dimensions?.h,
      d: durationMs ?? undefined,
      exp: Date.now() + MEDIA_TOKEN_TTL_MS,
    });
  } catch (err) {
    if (err instanceof MediaSigningNotConfiguredError) {
      return NextResponse.json({ error: "Uploads aren't configured" }, { status: 503 });
    }
    throw err;
  }

  return NextResponse.json(
    {
      type: MESSAGE_TYPE[sniffed.kind],
      mediaUrl: uploaded.url,
      mediaMime: sniffed.mime,
      mediaSize: file.size,
      mediaName: name,
      mediaDurationMs: durationMs,
      // The only field message:send actually trusts.
      mediaToken,
    },
    { status: 201 },
  );
}
