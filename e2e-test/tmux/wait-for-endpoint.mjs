import net from "node:net";

const endpoint = process.argv[2];
if (!endpoint) {
  console.error("Usage: node e2e-test/tmux/wait-for-endpoint.mjs <url>");
  process.exit(2);
}

const url = new URL(endpoint);
const host = url.hostname;
const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
const deadline = Date.now() + 10_000;

while (Date.now() < deadline) {
  if (await canConnect(host, port)) process.exit(0);
  await new Promise((resolve) => setTimeout(resolve, 100));
}

console.error(`Timed out waiting for ${host}:${port}.`);
process.exit(1);

function canConnect(host, port) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(500);
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}
