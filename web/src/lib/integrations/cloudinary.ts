import { randomBytes } from "node:crypto";
import { v2 as cloudinary, type UploadApiResponse } from "cloudinary";

/** Thrown when the CLOUDINARY_* env vars are absent — routes map this to 503, not 500. */
export class CloudinaryNotConfiguredError extends Error {}

// 1:1 crop applied as an INCOMING transformation, so the *stored* asset is the
// 512² face crop with EXIF gone. Using `eager` instead would leave the pristine
// original — full resolution, GPS EXIF intact — permanently fetchable at the
// untransformed delivery URL, silently defeating Docs/user/profile.md §4's
// "EXIF stripped". Trade-off: the crop is baked in and can't be re-derived.
const AVATAR_TRANSFORM = { width: 512, height: 512, crop: "fill", gravity: "face" } as const;

// Lazily configured, same reason as lib/integrations/brevo.ts: this module loads at build,
// type-check, and CLI time, not just per-request, so importing it must never
// throw just because credentials aren't set yet.
let configured = false;
function getCloudinary() {
  if (configured) return cloudinary;
  const cloud_name = process.env.CLOUDINARY_CLOUD_NAME;
  const api_key = process.env.CLOUDINARY_API_KEY;
  const api_secret = process.env.CLOUDINARY_API_SECRET;
  if (!cloud_name || !api_key || !api_secret) {
    throw new CloudinaryNotConfiguredError(
      "CLOUDINARY_CLOUD_NAME / CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET are not set",
    );
  }
  cloudinary.config({ cloud_name, api_key, api_secret, secure: true });
  configured = true;
  return cloudinary;
}

/** Cloudinary's own asset classes. "raw" is anything it won't transcode. */
export type CloudinaryResourceType = "image" | "video" | "raw";

type UploadOptions = {
  /** Path prefix, e.g. "avatars". The scope id and a random id are appended. */
  folder: string;
  /** The user id for avatars, the conversation id for chat media — whatever a
   *  cleanup sweep would want to walk as a single prefix. */
  ownerId: string;
  transformation?: Record<string, unknown>[];
  /** Defaults to "image". Video and raw assets fail as images, and a raw asset
   *  deleted with the wrong resource_type silently reports "not found". */
  resourceType?: CloudinaryResourceType;
};

/**
 * Uploads already-validated image bytes; returns the public_id Cloudinary stored.
 *
 * Generic in folder/transform because Docs/chat/chat.md §2.7 reuses this exact
 * pipeline for message media, with a different bucket.
 *
 * Streams the Buffer rather than building a base64 data URI — the data-URI form
 * would add a full +33% string copy of the payload for no benefit.
 */
export async function uploadAsset(
  buffer: Buffer,
  options: UploadOptions,
): Promise<{ publicId: string; url: string }> {
  const client = getCloudinary();
  const resourceType = options.resourceType ?? "image";
  // Entirely server-generated: no filename, no user input, so no path traversal.
  const publicId = `${options.folder}/${options.ownerId}/${randomBytes(12).toString("hex")}`;

  const result = await new Promise<UploadApiResponse>((resolve, reject) => {
    const stream = client.uploader.upload_stream(
      {
        // Full path as public_id rather than the `folder` option: in accounts
        // using dynamic folder mode `folder` becomes an asset_folder that ISN'T
        // part of the returned public_id, so the same code would store
        // different strings depending on an account setting.
        public_id: publicId,
        resource_type: resourceType,
        // Transformations only apply to images; passing one for raw is an error.
        ...(resourceType === "image" ? { transformation: options.transformation ?? [AVATAR_TRANSFORM] } : {}),
        overwrite: false,
        use_filename: false,
        unique_filename: false,
        invalidate: false, // brand-new URL, nothing cached to purge
      },
      (error, res) => (res ? resolve(res) : reject(error ?? new Error("Cloudinary upload returned no result"))),
    );
    stream.end(buffer);
  });

  // Store what Cloudinary actually assigned, never a locally rebuilt string —
  // in dynamic-folder-mode accounts the two differ.
  return { publicId: result.public_id, url: result.secure_url };
}

/** Back-compat wrapper for the avatar route, which only ever uploads images. */
export async function uploadImage(buffer: Buffer, options: Omit<UploadOptions, "resourceType">): Promise<string> {
  const { publicId } = await uploadAsset(buffer, options);
  return publicId;
}

/**
 * Always call best-effort — a failed delete must not fail the request (profile.md §5).
 *
 * resourceType has to match what was uploaded: destroying a video with
 * resource_type "image" returns `{ result: "not found" }` and succeeds
 * silently, leaking the asset forever.
 */
export async function destroyAsset(publicId: string, resourceType: CloudinaryResourceType = "image"): Promise<void> {
  await getCloudinary().uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
}

export async function destroyImage(publicId: string): Promise<void> {
  await destroyAsset(publicId, "image");
}

export const AVATAR_FOLDER = "avatars";
/** Chat media is scoped by conversation, not by uploader, so a sweep can walk
 *  one prefix per conversation. */
export const CHAT_MEDIA_FOLDER = "chat";
