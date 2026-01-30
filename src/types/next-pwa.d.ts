declare module 'next-pwa' {
  import { NextConfig } from 'next';

  interface PWAConfig {
    dest?: string;
    register?: boolean;
    skipWaiting?: boolean;
    disable?: boolean;
    scope?: string;
    sw?: string;
    runtimeCaching?: unknown[];
    publicExcludes?: string[];
    buildExcludes?: string[] | RegExp[];
    fallbacks?: {
      document?: string;
      image?: string;
      audio?: string;
      video?: string;
      font?: string;
    };
  }

  export default function withPWA(config?: PWAConfig): (nextConfig: NextConfig) => NextConfig;
}
