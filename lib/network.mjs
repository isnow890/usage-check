import net from "node:net";
import os from "node:os";

/**
 * Whether this dashboard is reachable from anything other than this machine is
 * not something the process can read off its own config: `next start` may have
 * been given a `-H`, a port, or neither, and the launchd plist is generated.
 *
 * So it is measured instead. For every non-internal address the machine owns,
 * we try to open a TCP connection to our own port on that address. Loopback
 * always answers; a LAN address only answers when the server is actually
 * listening on it. That distinction is the whole point of the probe.
 *
 * This over-reports in one direction: a host firewall can still reject remote
 * peers while the local connection succeeds. Treat a positive result as
 * "exposed unless something else is blocking", never as "definitely reachable".
 */

const MEMO_MS = 60_000;
const PROBE_TIMEOUT_MS = 600;

let memo = { at: 0, port: null, value: null };

/**
 * Tailscale hands out addresses from the CGNAT range, so 100.64/10 tells us a
 * peer is on the tailnet rather than on the coffee-shop Wi-Fi. It is a range
 * check, not an identification: other CGNAT users land there too.
 */
function classify(address) {
  const [a, b] = address.split(".").map(Number);
  if (a === 100 && b >= 64 && b <= 127) return "tailnet";
  if (a === 10) return "lan";
  if (a === 192 && b === 168) return "lan";
  if (a === 172 && b >= 16 && b <= 31) return "lan";
  if (a === 127) return "loopback";
  return "other";
}

function localAddresses() {
  const out = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") continue;
      out.push({ name, address: entry.address, kind: classify(entry.address) });
    }
  }
  return out;
}

function answers(address, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: address, port });
    const settle = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

export async function inspectExposure({ port }) {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  if (memo.port === port && Date.now() - memo.at < MEMO_MS) return memo.value;

  const addresses = localAddresses();
  const reachable = [];
  for (const entry of addresses) {
    if (await answers(entry.address, port)) reachable.push(entry);
  }

  const value = { method: "self-probe", port, addresses, reachable };
  memo = { at: Date.now(), port, value };
  return value;
}
