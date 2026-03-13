import type { NextConfig } from "next";

const dev = process.env.COCKPIT_ENV === 'dev';

const nextConfig: NextConfig = {
  // dev 和 prod 使用不同输出目录，避免 Turbopack 热更新影响 prod
  distDir: dev ? '.next' : '.next-prod',
  turbopack: {},
};

export default nextConfig;
