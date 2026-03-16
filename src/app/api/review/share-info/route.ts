import { NextResponse } from 'next/server';
import { networkInterfaces } from 'os';

function getLanIPs(): string[] {
  const interfaces = networkInterfaces();
  const ips: string[] = [];
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface || []) {
      if (alias.family === 'IPv4' && !alias.internal) {
        ips.push(alias.address);
      }
    }
  }
  return ips;
}

// GET - 返回分享服务的 LAN 地址
export async function GET() {
  const port = parseInt(process.env.COCKPIT_PORT || '3456', 10);
  const sharePort = port + 1000;
  const lanIPs = getLanIPs();

  return NextResponse.json({
    sharePort,
    shareBase: lanIPs.length > 0 ? `http://${lanIPs[0]}:${sharePort}` : null,
  });
}
