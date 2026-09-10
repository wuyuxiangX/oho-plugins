import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { createOAuthDrivers } from "./oauth-drivers.js";

const schema = z
  .object({
    activeVersion: z.string().regex(/^[a-zA-Z0-9._-]{1,80}$/),
    versions: z.record(
      z.string(),
      z.record(
        z.string(),
        z
          .object({
            clientId: z.string().optional(),
            clientSecret: z.string().optional(),
          })
          .strict(),
      ),
    ),
  })
  .strict();

/** Private plugin-service configuration, reread for every operation. Retain old
 * versions while grants issued to those OAuth apps are still in use. */
export function oauthConfiguration(
  path = process.env.OHO_PLUGIN_OAUTH_CONFIG_PATH ??
    join(homedir(), ".config/oho-plugins/oauth.json"),
  fetchImpl = fetch,
) {
  async function read(version?: string) {
    const info = await lstat(path);
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      (info.mode & 0o777) !== 0o600 ||
      info.size > 131072
    )
      throw new Error("invalid_oauth_configuration");
    const config = schema.parse(JSON.parse(await readFile(path, "utf8")));
    const selected = version ?? config.activeVersion;
    if (!Object.hasOwn(config.versions, selected))
      throw new Error("oauth_configuration_version_missing");
    return {
      version: selected,
      drivers: createOAuthDrivers(config.versions[selected]!, fetchImpl),
    };
  }
  return {
    current: () => read(),
    resolve: async (id: string, version?: string) => {
      const config = await read(version);
      return { version: config.version, driver: config.drivers.get(id) };
    },
  };
}
