import type { NextConfig } from "next";
import path from "path";

// Bundle the monorepo editor core from source — mirrors the tsconfig path
// alias ("@pixelforge/core" -> ./packages/core/src/index.ts); the package
// ships only a stale dist build, so the bundler must compile src/index.ts.
// Turbopack + webpack both resolve the absolute alias below.
const CORE_ALIAS = "./packages/core/src/index.ts";

const nextConfig: NextConfig = {
  output: "standalone",
  // pin the standalone root to the project — prevents nesting when a
  // stray package.json exists in a parent directory (C:/Users/<name>)
  outputFileTracingRoot: path.resolve(__dirname),
  /* config options here */
  reactStrictMode: false,
  // keep the studio chrome clean — no dev-mode badge/icon overlays
  devIndicators: false,
  turbopack: {
    resolveAlias: {
      "@pixelforge/core": CORE_ALIAS,
    },
  },
  webpack: (config) => {
    config.resolve = config.resolve ?? {};
    config.resolve.alias = {
      ...(config.resolve.alias ?? {}),
      "@pixelforge/core": path.resolve(process.cwd(), "packages/core/src/index.ts"),
    };
    return config;
  },
};

export default nextConfig;
