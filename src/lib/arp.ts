import { execSync } from 'child_process';
import { createHash } from 'crypto';

/**
 * 通过 ARP 表查询 IP 对应的 MAC 地址
 * 仅适用于同一 L2 子网的局域网设备
 */
export function getMacByIp(ip: string): string | null {
  try {
    // macOS: arp -n <ip> → "? (10.0.0.2) at bc:24:11:9a:a1:52 on en0 ..."
    const output = execSync(`arp -n ${ip}`, { timeout: 3000, encoding: 'utf8' });
    const match = output.match(/at\s+([0-9a-fA-F:]+)\s+on/);
    if (match && match[1] !== '(incomplete)') {
      return match[1].toLowerCase();
    }
  } catch { /* arp 失败或超时 */ }
  return null;
}

/**
 * 将 MAC 地址 hash 为稳定的 authorId（不暴露原始 MAC）
 */
export function macToAuthorId(mac: string): string {
  return createHash('sha256').update(`cockpit:${mac}`).digest('hex').slice(0, 16);
}
