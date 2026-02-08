import type { MetadataRoute } from 'next'

const ICON_SIZES = [72, 96, 128, 144, 152, 192, 384, 512]

export default function manifest(): MetadataRoute.Manifest {
  const isDev = process.env.COCKPIT_ENV === 'dev'
  const iconPath = isDev ? '/icons/dev' : '/icons'

  return {
    name: isDev ? 'Cockpit (Dev)' : 'Cockpit',
    short_name: isDev ? 'Cockpit Dev' : 'Cockpit',
    description: 'One seat. One AI. Everything under control.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f9f9fb',
    theme_color: '#111113',
    orientation: 'portrait-primary',
    // Chrome 139+: 点击匹配 scope 的链接时，复用已有 PWA 窗口而非打开新 Chrome Tab
    launch_handler: {
      client_mode: 'navigate-existing',
    },
    icons: ICON_SIZES.map((size) => ({
      src: `${iconPath}/icon-${size}x${size}.png`,
      sizes: `${size}x${size}`,
      type: 'image/png',
      purpose: 'maskable any' as 'any',
    })),
  }
}
