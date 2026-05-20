/**
 * /api/review/share-info — P8+ migration
 */
import { networkInterfaces } from "os"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { CockpitConfig } from "@cockpit/effect-core"

function getLanIPs(): string[] {
  const interfaces = networkInterfaces()
  const ips: string[] = []
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface || []) {
      if (alias.family === "IPv4" && !alias.internal) {
        ips.push(alias.address)
      }
    }
  }
  return ips
}

export const GET = handler(() =>
  Effect.gen(function* () {
    const cfg = yield* CockpitConfig
    const sharePort = cfg.port + 1000
    const lanIPs = getLanIPs()
    return ok({
      sharePort,
      shareBase:
        lanIPs.length > 0 ? `http://${lanIPs[0]}:${sharePort}` : null,
    })
  })
)
