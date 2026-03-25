import type { NextConfig } from "next";

const dev = process.env.COCKPIT_ENV === 'dev';

const nextConfig: NextConfig = {
  // dev 和 prod 使用不同输出目录，避免 Turbopack 热更新影响 prod
  distDir: dev ? '.next' : '.next-prod',
  turbopack: {},
  // 这些包不让 webpack 打包，运行时从 node_modules 加载
  // claude-agent-sdk: 内部通过 __dirname 定位 cli.js，打包会把路径硬编码为构建机路径
  // node-pty: 原生模块，不能被 webpack 打包
  serverExternalPackages: [
    '@anthropic-ai/claude-agent-sdk',
    'node-pty',
  ],
};

export default nextConfig;
