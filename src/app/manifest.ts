import type { MetadataRoute } from 'next'

const ICON_SIZES = [72, 96, 128, 144, 152, 192, 384, 512]

export default function manifest(): MetadataRoute.Manifest {
  const isDev = process.env.COCKPIT_ENV === 'dev'
  const iconPath = isDev ? '/icons/dev' : '/icons'

  return {
    name: isDev ? 'OpenCockpit (Dev)' : 'OpenCockpit',
    short_name: isDev ? 'Cockpit Dev' : 'Cockpit',
    description: 'OpenCockpit is a local-first AI development hub with chat agents, a file explorer, terminals, and browser bubbles in one swipeable workspace. One seat. One AI.',
    // Stable identity + full scope so the installed PWA captures every in-app
    // navigation (desktop workspace AND the mobile /m route).
    id: '/',
    scope: '/',
    // start_url stays '/' on purpose — it's adaptive: boot.js redirects narrow
    // viewports to /m before first paint, while desktop installs land on the
    // full workspace. Hard-coding '/m' would trap desktop PWA users in mobile UI.
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
