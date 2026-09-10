import { createManagedPluginServer } from "./managed-server.js";
import { oauthConfiguration } from "./oauth-configuration.js";
import { configureOutboundProxy } from "./outbound-proxy.js";

configureOutboundProxy();
const token = process.env.OHO_PLUGIN_SERVICE_TOKEN ?? "";
const redirectUri = process.env.OHO_PLUGIN_REDIRECT_URI;
if (!redirectUri) throw new Error("OHO_PLUGIN_REDIRECT_URI is required");
const config = oauthConfiguration();
const server = createManagedPluginServer({
  serviceToken: token,
  redirectUri,
  drivers: config.current,
  resolveDriver: config.resolve,
});
server.listen(Number(process.env.OHO_PLUGIN_PORT ?? 0), "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string")
    console.log(
      `Managed plugin service listening on 127.0.0.1:${address.port}`,
    );
});
process.on("SIGTERM", () => server.close());
