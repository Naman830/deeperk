const CLOUD_NAME = process.env.NEXT_PUBLIC_CLOUDINARY_CLOUD_NAME;

// Build the avatar URL from the stored public_id.
export function avatarUrl(
  publicId: string | null | undefined, 
  size = 512
): string | null {
  if (!publicId || !CLOUD_NAME) return null;
  
  return `https://res.cloudinary.com/${CLOUD_NAME}/image/upload/f_auto,q_auto,w_${size},h_${size},c_fill/${publicId}`;
}
