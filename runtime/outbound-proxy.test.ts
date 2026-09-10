import { once } from "node:events";
import { createServer } from "node:http";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import { expect, it, vi } from "vitest";
import { configureOutboundProxy } from "./outbound-proxy.js";

it("routes provider fetches through the configured proxy and keeps loopback direct", async () => {
  const previous = getGlobalDispatcher();
  const destinations: string[] = [];
  const proxy = createServer();
  proxy.on("connect", (req, socket) => {
    destinations.push(req.url!);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.once("data", () =>
      socket.end(
        "HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied",
      ),
    );
  });
  const local = createServer((_req, res) => res.end("direct"));
  proxy.listen(0, "127.0.0.1");
  local.listen(0, "127.0.0.1");
  await Promise.all([once(proxy, "listening"), once(local, "listening")]);
  const port = (server: typeof proxy) =>
    (server.address() as { port: number }).port;
  try {
    vi.stubEnv("HTTP_PROXY", `http://127.0.0.1:${port(proxy)}`);
    vi.stubEnv("HTTPS_PROXY", `http://127.0.0.1:${port(proxy)}`);
    vi.stubEnv("NO_PROXY", "");
    configureOutboundProxy();
    const external = await fetch("http://provider.invalid/token", {
      signal: AbortSignal.timeout(2000),
    });
    expect(await external.text()).toBe("proxied");
    const internal = await fetch(`http://127.0.0.1:${port(local)}/`, {
      signal: AbortSignal.timeout(2000),
    });
    expect(await internal.text()).toBe("direct");
    expect(destinations).toEqual(["provider.invalid:80"]);
  } finally {
    const current = getGlobalDispatcher();
    setGlobalDispatcher(previous);
    if (current !== previous) await current.destroy();
    vi.unstubAllEnvs();
    proxy.closeAllConnections();
    local.closeAllConnections();
    await Promise.all([
      new Promise<void>((r) => proxy.close(() => r())),
      new Promise<void>((r) => local.close(() => r())),
    ]);
  }
});
