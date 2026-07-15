import { withPayload } from "@payloadcms/next/withPayload";
import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dirname, "../..");
const apiRewriteUrl = process.env.KOTH_API_REWRITE_URL ?? "http://localhost:4000";

const nextConfig = {
  output: "standalone",
  outputFileTracingRoot: repoRoot,
  images: {
    remotePatterns: [{ protocol: "https", hostname: "static-cdn.jtvnw.net" }],
  },
  async rewrites() {
    return [
      { source: "/api/auth/:path*", destination: `${apiRewriteUrl}/api/auth/:path*` },
      {
        source: "/api/predictions/:path*",
        destination: `${apiRewriteUrl}/api/predictions/:path*`,
      },
      { source: "/api/twitch/:path*", destination: `${apiRewriteUrl}/api/twitch/:path*` },
      { source: "/api/health/live", destination: `${apiRewriteUrl}/api/health/live` },
      { source: "/api/health/ready", destination: `${apiRewriteUrl}/api/health/ready` },
    ];
  },
  turbopack: {
    root: repoRoot,
  },
} satisfies NextConfig;

export default withPayload(nextConfig, { devBundleServerPackages: false });
