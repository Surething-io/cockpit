import type { NextConfig } from "next";
import withPWAInit from "next-pwa";

const withPWA = withPWAInit({
  dest: "public",
  register: true,
  skipWaiting: true,
  disable: process.env.NODE_ENV === "development", // 开发环境禁用 PWA
});

const nextConfig: NextConfig = {
  turbopack: {},
};

export default withPWA(nextConfig);
