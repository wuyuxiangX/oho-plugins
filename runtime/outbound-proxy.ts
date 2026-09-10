import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

/** Node's fetch must explicitly opt in to the operator's network proxy. */
export function configureOutboundProxy() {
  const httpProxy = process.env.HTTP_PROXY ?? process.env.http_proxy;
  const httpsProxy =
    process.env.HTTPS_PROXY ?? process.env.https_proxy ?? httpProxy;
  if (!httpProxy && !httpsProxy) return;
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      httpProxy,
      httpsProxy,
      noProxy: [
        process.env.NO_PROXY ?? process.env.no_proxy ?? "",
        "localhost",
        "127.0.0.1",
        "::1",
      ].join(","),
    }),
  );
}
