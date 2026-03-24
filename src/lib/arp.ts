import { execSync } from 'child_process';
import { createHash } from 'crypto';
import { isMac, isWindows } from './platform';

/**
 * Look up the MAC address for an IP via the ARP table.
 * Only works for devices on the same L2 subnet.
 */
export function getMacByIp(ip: string): string | null {
  try {
    if (isMac) {
      // macOS: arp -n <ip> → "? (10.0.0.2) at bc:24:11:9a:a1:52 on en0 ..."
      const output = execSync(`arp -n ${ip}`, { timeout: 3000, encoding: 'utf8' });
      const match = output.match(/at\s+([0-9a-fA-F:]+)\s+on/);
      if (match && match[1] !== '(incomplete)') return match[1].toLowerCase();
    } else if (isWindows) {
      // Windows: arp -a <ip> → "  10.0.0.2  bc-24-11-9a-a1-52  dynamic"
      const output = execSync(`arp -a ${ip}`, { timeout: 3000, encoding: 'utf8' });
      const match = output.match(/([0-9a-fA-F]{2}-[0-9a-fA-F]{2}-[0-9a-fA-F]{2}-[0-9a-fA-F]{2}-[0-9a-fA-F]{2}-[0-9a-fA-F]{2})/);
      if (match) return match[1].replace(/-/g, ':').toLowerCase();
    } else {
      // Linux: arp -n <ip> → "10.0.0.2  ether  bc:24:11:9a:a1:52  C  eth0"
      const output = execSync(`arp -n ${ip}`, { timeout: 3000, encoding: 'utf8' });
      const match = output.match(/([0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2}:[0-9a-fA-F]{2})/);
      if (match) return match[1].toLowerCase();
    }
  } catch { /* arp failed or timed out */ }
  return null;
}

/**
 * Hash a MAC address into a stable authorId (without exposing the raw MAC).
 */
export function macToAuthorId(mac: string): string {
  return createHash('sha256').update(`cockpit:${mac}`).digest('hex').slice(0, 16);
}
