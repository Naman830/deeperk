import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Kept for the day something switches to next/image. Nothing uses it today:
    // avatars render through Radix's AvatarImage (a plain <img>), which bypasses
    // Next's optimizer entirely, and Cloudinary has already applied f_auto/q_auto
    // and a size in lib/avatar-url.ts. remotePatterns only gates /_next/image.
    remotePatterns: [{ protocol: "https", hostname: "res.cloudinary.com" }],
  },
};

export default nextConfig;
