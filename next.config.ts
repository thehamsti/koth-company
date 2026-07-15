import { withPayload } from "@payloadcms/next/withPayload";
import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

const nextConfig = {
  images: {
    remotePatterns: [{ protocol: "https", hostname: "static-cdn.jtvnw.net" }],
  },
  turbopack: {
    root: path.resolve(dirname),
  },
} satisfies NextConfig;

export default withPayload(nextConfig, { devBundleServerPackages: false });
