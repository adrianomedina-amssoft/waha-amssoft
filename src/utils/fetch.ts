import axios from 'axios';
import { resolve4 } from 'dns/promises';
import { Agent as HttpsAgent } from 'https';
import { BlockList, isIP } from 'net';

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10],
  ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 3],
] as [string, number][]) {
  blocked.addSubnet(network, prefix, 'ipv4');
}

/** Fail closed: only explicitly permitted HTTPS origins and public IPv4 DNS. */
export async function fetchBuffer(value: string): Promise<Buffer> {
  if (process.env.AMSSOFT_STATUS_ONLY === 'true') {
    throw new Error('Remote media URLs are disabled in Status-only mode');
  }
  const url = new URL(value);
  const hosts = (process.env.WAHA_MEDIA_ALLOWED_HOSTS || '')
    .split(',').map((host) => host.trim().toLowerCase()).filter(Boolean);
  if (url.protocol !== 'https:' || url.username || url.password ||
      (url.port && url.port !== '443') || isIP(url.hostname) ||
      !hosts.includes(url.hostname.toLowerCase())) {
    throw new Error('Media origin is not permitted');
  }
  const addresses = await resolve4(url.hostname);
  const extraBlocked = (process.env.WAHA_MEDIA_BLOCKED_IPS || '').split(',');
  if (!addresses.length || addresses.some((address) =>
    isIP(address) !== 4 || blocked.check(address, 'ipv4') || extraBlocked.includes(address))) {
    throw new Error('Media DNS destination is not permitted');
  }
  // Pin the validated address while preserving the original hostname for TLS/SNI.
  const address = addresses[0];
  const agent = new HttpsAgent({
    rejectUnauthorized: true,
    lookup: (hostname, options, callback) => {
      if (hostname !== url.hostname) {
        callback(new Error('Unexpected media hostname'), '', 4);
        return;
      }
      if (options.all) {
        callback(null, [{ address: address, family: 4 }]);
      } else {
        callback(null, address, 4);
      }
    },
  });
  try {
    const response = await axios.get(url.href, {
      responseType: 'arraybuffer', httpsAgent: agent, proxy: false,
      timeout: 15_000, maxRedirects: 0,
      maxContentLength: 32 * 1024 * 1024, maxBodyLength: 32 * 1024 * 1024,
      signal: AbortSignal.timeout(15_000),
    });
    return Buffer.from(response.data);
  } finally {
    agent.destroy();
  }
}
