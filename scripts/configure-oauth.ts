import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { createOAuthDrivers } from "../runtime/oauth-drivers.js";

// Secrets enter through stdin, never argv, logs or a checked-in environment file.
async function main() {
  const id = process.argv[2] ?? "";
  if (!createOAuthDrivers({}).has(id))
    throw new Error("Choose a plugin with an OAuth adapter");
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk.toString();
    if (raw.length > 16384) throw new Error("OAuth configuration is too large");
  }
  const credential = z
    .object({
      clientId: z.string().min(1).max(4096),
      clientSecret: z.string().min(1).max(8192).optional(),
    })
    .strict()
    .parse(JSON.parse(raw));
  const path =
    process.env.OHO_PLUGIN_OAUTH_CONFIG_PATH ??
    join(homedir(), ".config/oho-plugins/oauth.json");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Serialize operator updates too; never silently lose another plugin's configuration.
  const lock = `${path}.lock`;
  await mkdir(lock, { mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    let current: {
      activeVersion: string;
      versions: Record<
        string,
        Record<string, { clientId: string; clientSecret?: string }>
      >;
    };
    try {
      const info = await lstat(path);
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        (info.mode & 0o777) !== 0o600
      )
        throw new Error("Invalid private OAuth configuration file");
      current = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      current = { activeVersion: "", versions: {} };
    }
    const version = randomUUID();
    // A secret rotation must also update grants pinned to the same OAuth app.
    for (const providers of Object.values(current.versions)) {
      if (providers[id]?.clientId === credential.clientId)
        providers[id] = credential;
    }
    current.versions[version] = {
      ...current.versions[current.activeVersion],
      [id]: credential,
    };
    current.activeVersion = version;
    const contents = JSON.stringify(current, null, 2) + "\n";
    if (Buffer.byteLength(contents) > 131072)
      throw new Error("OAuth configuration is too large");
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
    await chmod(path, 0o600);
    console.log(
      `Updated OAuth configuration for ${id}. New authorizations use ${version}; no service restart is needed.`,
    );
  } finally {
    await rm(temporary, { force: true });
    await rm(lock, { recursive: true });
  }
}
void main().catch(() => {
  // JSON parser and filesystem errors may contain secret input or file contents.
  console.error(
    "OAuth configuration was not updated. Check the plugin ID, input JSON and private file permissions, and ensure no other update is running.",
  );
  process.exitCode = 1;
});
