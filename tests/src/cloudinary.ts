/**
 * Raw Cloudinary Admin REST helper — zero new dependencies, basic-auth fetch
 * against the same account the app uses. Only the cron spec uses it, and only
 * against fixture-owned `avatars/<userId>/` prefixes; production code goes
 * through web/src/lib/integrations/cloudinary.ts instead.
 */

function adminBase(): { base: string; auth: string } {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  const key = process.env.CLOUDINARY_API_KEY;
  const secret = process.env.CLOUDINARY_API_SECRET;
  if (!cloud || !key || !secret) {
    throw new Error("CLOUDINARY_* env vars missing — the cron spec needs the real account");
  }
  return {
    base: `https://api.cloudinary.com/v1_1/${cloud}`,
    auth: `Basic ${Buffer.from(`${key}:${secret}`).toString("base64")}`,
  };
}

/** public_ids currently stored under avatars/<userId>/ (≤100 — plenty for fixtures). */
export async function listAvatarAssets(userId: string): Promise<string[]> {
  const { base, auth } = adminBase();
  const prefix = encodeURIComponent(`avatars/${userId}/`);
  const res = await fetch(`${base}/resources/image/upload?prefix=${prefix}&max_results=100`, {
    headers: { authorization: auth },
  });
  if (!res.ok) {
    throw new Error(`Cloudinary list failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  }
  const body = (await res.json()) as { resources: { public_id: string }[] };
  return body.resources.map((resource) => resource.public_id);
}

/** Best-effort afterAll cleanup so a failed run can't leak fixture assets. */
export async function destroyAvatarPrefix(userId: string): Promise<void> {
  try {
    const { base, auth } = adminBase();
    const prefix = encodeURIComponent(`avatars/${userId}/`);
    await fetch(`${base}/resources/image/upload?prefix=${prefix}`, {
      method: "DELETE",
      headers: { authorization: auth },
    });
  } catch {
    // Cleanup is best-effort by definition.
  }
}
