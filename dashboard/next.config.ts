import type { NextConfig } from "next";

const config: NextConfig = {
  output: "export",
  outputFileTracingRoot: process.cwd(),
  poweredByHeader: false,
  images: { unoptimized: true },
};
export default config;
