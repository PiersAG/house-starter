import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), browsing-topics=()",
  },
  { key: "X-Frame-Options", value: "DENY" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
];

const nextConfig: NextConfig = {
  // Ship .env.contract inside the serverless bundle so instrumentation.ts can
  // validate the running environment against it at boot on the host (not just
  // in CI, where the file sits at the repo-root cwd). Keyed by a catch-all
  // route glob because the boot validator runs for every request path. If the
  // file is not bundled the validator warns and skips rather than crashing.
  outputFileTracingIncludes: {
    "/**": ["./.env.contract"],
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: securityHeaders,
      },
    ];
  },
};

export default nextConfig;
