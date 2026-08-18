import type { MediaKind } from "@/lib/validation/chat";

/**
 * Real format read from the bytes, never from the filename or the client's
 * declared MIME.
 *
 * This runs BEFORE `sharp()` is ever constructed. sharp's bundled libvips
 * includes librsvg, so checking `metadata.format` afterwards would mean
 * attacker-controlled XML had already been parsed — an SVG carrying a <script>
 * becomes stored XSS, because Cloudinary serves assets from its own origin.
 * Sniffing first keeps SVG, PDF-as-image, TIFF and HEIF bytes away from any
 * image loader at all.
 *
 * Allowlist, never a denylist: an unrecognised signature is rejected.
 *
 * Extracted from api/me/avatar/route.ts so chat media and avatars share one
 * copy. Two copies is exactly how the SVG exclusion gets lost from one of them.
 */

export type SniffResult = {
  kind: MediaKind;
  /** sharp's format name for images; a short tag otherwise. */
  format: string;
  mime: string;
};

// ISO base media brands we accept. Anything else with an ftyp box is refused
// rather than passed to Cloudinary to identify for us.
const ISO_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "mp4v", "avc1", "qt  ", "M4V "]);

function startsWith(buffer: Buffer, bytes: number[]): boolean {
  if (buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

export function sniffMedia(buffer: Buffer): SniffResult | null {
  if (buffer.length < 12) return null;

  // --- images ---
  if (startsWith(buffer, [0xff, 0xd8, 0xff])) return { kind: "image", format: "jpeg", mime: "image/jpeg" };
  if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { kind: "image", format: "png", mime: "image/png" };
  }
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") {
    return { kind: "image", format: "webp", mime: "image/webp" };
  }

  // --- video ---
  if (startsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) {
    // EBML: Matroska or WebM. Cloudinary handles both as resource_type video.
    return { kind: "video", format: "webm", mime: "video/webm" };
  }
  if (buffer.subarray(4, 8).toString("ascii") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("ascii");
    if (ISO_BRANDS.has(brand)) {
      const isQuickTime = brand === "qt  ";
      return {
        kind: "video",
        format: isQuickTime ? "mov" : "mp4",
        mime: isQuickTime ? "video/quicktime" : "video/mp4",
      };
    }
    return null;
  }

  // --- generic files ---
  if (buffer.subarray(0, 5).toString("ascii") === "%PDF-") {
    return { kind: "file", format: "pdf", mime: "application/pdf" };
  }
  if (startsWith(buffer, [0x50, 0x4b, 0x03, 0x04])) {
    // ZIP container — also covers docx/xlsx/pptx.
    return { kind: "file", format: "zip", mime: "application/zip" };
  }

  return null;
}

/**
 * The narrower avatar allowlist (Docs/user/profile.md §4): JPEG, PNG, WebP only.
 * Kept as its own function so widening chat media can never silently widen
 * what an avatar accepts.
 */
export function sniffAvatarImage(buffer: Buffer): boolean {
  const result = sniffMedia(buffer);
  return result?.kind === "image";
}
