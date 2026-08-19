import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The browser must reach Socket.IO on the web app's OWN origin: the session
  // cookie is host-only and server/src/middlewares/auth.js's handshake reads it, so a
  // cross-site socket URL arrives with no cookie and every connection is
  // rejected. Proxying /socket.io/ keeps it same-origin (Docs/deployment/deploy.md).
  // On Vercel the WebSocket upgrade can't pass through a rewrite; engine.io's
  // probe fails gracefully and the connection stays on HTTP long-polling.
  // In dev this rewrite is unused — the client connects to :4000 directly.
  async rewrites() {
    const socket = process.env.SOCKET_INTERNAL_URL;
    if (!socket) return [];
    return [
      { source: "/socket.io/:path*", destination: `${socket}/socket.io/:path*` },
    ];
  },
  images: {
    // Kept for the day something switches to next/image. Nothing uses it today:
    // avatars render through Radix's AvatarImage (a plain <img>), which bypasses
    // Next's optimizer entirely, and Cloudinary has already applied f_auto/q_auto
    // and a size in lib/avatar-url.ts. remotePatterns only gates /_next/image.
    remotePatterns: [{ protocol: "https", hostname: "res.cloudinary.com" }],
  },
};

export default nextConfig;
