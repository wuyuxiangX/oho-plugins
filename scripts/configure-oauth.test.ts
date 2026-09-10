import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

async function configure(path: string, input: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./configure-oauth.ts", import.meta.url)),
      "gmail",
    ],
    {
      env: { ...process.env, OHO_PLUGIN_OAUTH_CONFIG_PATH: path },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  child.stdin.end(input);
  const [code] = await once(child, "close");
  return { code, output };
}

it("atomically rotates secrets for existing grants without changing their client IDs or logging secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oho-oauth-configure-"));
  const path = join(dir, "oauth.json");
  try {
    await writeFile(
      path,
      JSON.stringify({
        activeVersion: "v2",
        versions: {
          v1: { gmail: { clientId: "old-app", clientSecret: "old-secret" } },
          v2: {
            gmail: { clientId: "current-app", clientSecret: "current-secret" },
          },
        },
      }),
      { mode: 0o600 },
    );
    const result = await configure(
      path,
      JSON.stringify({
        clientId: "current-app",
        clientSecret: "rotated-secret",
      }),
    );
    expect(result.code).toBe(0);
    expect(result.output).not.toContain("rotated-secret");
    const config = JSON.parse(await readFile(path, "utf8"));
    expect(config.versions.v1.gmail).toEqual({
      clientId: "old-app",
      clientSecret: "old-secret",
    });
    expect(config.versions.v2.gmail.clientSecret).toBe("rotated-secret");
    expect(config.versions[config.activeVersion].gmail.clientSecret).toBe(
      "rotated-secret",
    );
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    const before = await readFile(path, "utf8");
    const invalid = await configure(path, '{"clientSecret":"must-not-appear"');
    expect(invalid.code).toBe(1);
    expect(invalid.output).not.toContain("must-not-appear");
    expect(await readFile(path, "utf8")).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
