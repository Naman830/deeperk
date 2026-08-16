import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  images: {
    // Avatars are delivered from Cloudinary (web/src/lib/avatar-url.ts), already
    // sized and f_auto/q_auto'd there — <Avatar> passes `unoptimized` so Next
    // doesn't re-optimize an already-optimized asset.
    remotePatterns: [{ protocol: "https", hostname: "res.cloudinary.com" }],
  },
};

export default nextConfig;
