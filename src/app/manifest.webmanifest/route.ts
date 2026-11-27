import type { MetadataRoute } from 'next'
import { hostnameOfHostHeader, isLoopbackHostname } from '../../lib/auth'

const ICON_SIZES = [72, 96, 128, 144, 152, 192, 384, 512]

// Per request, not static: the icon depends on the host the page was reached
// through. Every install is otherwise named and drawn the same in the Dock,
// Cmd+Tab and Launchpad, so each PWA wears a badge: a laptop when installed from
// localhost, a globe when installed from a remote server. The desktop app keeps
// the plain icon (desktop/src/launcher/icon.png) and never reads this manifest.
export const dynamic = 'force-dynamic'

export function GET(request: Request): Response {
  const isDev = process.env.COCKPIT_ENV === 'dev'
  const hostname = hostnameOfHostHeader(request.headers.get('host') ?? undefined)
  const isRemote = hostname !== null && !isLoopbackHostname(hostname)
  // Dev wins: its sparkle is what tells a developer which instance they are in.
  const iconPath = isDev ? '/icons/dev' : isRemote ? '/icons/remote' : '/icons/local'

  const manifest: MetadataRoute.Manifest = {
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

  return Response.json(manifest, {
    headers: { 'Content-Type': 'application/manifest+json' },
  })
}
