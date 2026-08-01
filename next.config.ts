import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Ensure instrumentation.ts register() runs on server boot (job poller).
  experimental: {
    instrumentationHook: true,
  },
};

export default nextConfig;
