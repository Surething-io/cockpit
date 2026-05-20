import type { MetadataRoute } from 'next'

const ICON_SIZES = [72, 96, 128, 144, 152, 192, 384, 512]

export default function manifest(): MetadataRoute.Manifest {
  const isDev = process.env.COCKPIT_ENV === 'dev'
  const iconPath = isDev ? '/icons/dev' : '/icons'

  return {
    name: isDev ? 'Cockpit (Dev)' : 'Cockpit',
    short_name: isDev ? 'Cockpit Dev' : 'Cockpit',
    description: 'Cockpit is a local-first AI development hub with chat agents, a file explorer, terminals, and browser bubbles in one swipeable workspace. One seat. One AI.',
    start_url: '/',
    display: 'standalone',
    background_color: '#f9f9fb',
    theme_color: '#111113',
    orientation: 'portrait-primary',
    // Chrome 139+: reuse the existing PWA window instead of opening a new Chrome tab when a matching scope link is clicked
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
