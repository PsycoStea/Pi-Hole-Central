import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: 'standalone',
  // Keep native/native-adjacent packages out of the bundler. ssh2 ships a
  // native crypto binding that Turbopack can't place into an ESM chunk; these
  // are required from node_modules at runtime instead (present in the image).
  // bcryptjs is external so the password worker (src/lib/bcrypt-worker.ts)
  // can require it from node_modules with either bundler.
  // undici (pinned) carries the Pi-hole node transport (src/lib/pihole/
  // transport.ts): loaded from node_modules so webpack (lab) and Turbopack
  // (prod) run the same copy.
  serverExternalPackages: ['ssh2', 'node-ssh', 'better-sqlite3', 'bcryptjs', 'undici'],
  // The app serves no remote or user-supplied images, so the optimiser is pure
  // attack surface: /_next/image is reachable without login (the auth proxy
  // exempts /_next) and has had several advisories.
  images: { unoptimized: true },
  poweredByHeader: false,
  // Every other subdomain of the same registrable domain is same-site to this
  // one, so SameSite=Lax cookies ride along when another subdomain frames
  // the dashboard. Nothing here is meant to be framed. Only frame-ancestors is
  // set: a full CSP would need nonces for Next's inline scripts.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'same-origin' },
        ],
      },
    ]
  },
};

export default nextConfig;
