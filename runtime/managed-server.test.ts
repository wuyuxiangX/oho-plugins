import { afterEach, describe, expect, it, vi } from "vitest";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectorOAuthDriver } from "./oauth.js";
import { createManagedPluginServer } from "./managed-server.js";
import { oauthConfiguration } from "./oauth-configuration.js";
import { GoogleWorkspaceClient } from "../providers/google-workspace/client.js";

const disposals: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const dispose of disposals.splice(0)) await dispose();
});
const token = "test-service-credential-32-characters-long";
const redirectUri = "http://127.0.0.1:12345/plugin-oauth/callback";
const credential = {
  schemaVersion: "connector.oauth.v1" as const,
  connectorId: "gmail" as const,
  accessToken: "private-provider-token",
  scopes: ["read"],
};
async function fixture(driverOverrides: Partial<ConnectorOAuthDriver> = {}) {
  const driver: ConnectorOAuthDriver = {
    connectorId: "gmail",
    configured: true,
    pkce: "S256",
    requiredScopes: ["read"],
    authorizationUrl: ({ state, codeChallenge }) =>
      new URL(
        `https://example.com/authorize?state=${state}&code_challenge=${codeChallenge}`,
      ),
    exchangeCode: vi.fn(async () => ({ credential })),
    getAccount: async () => ({ id: "account", label: "Account" }),
    ...driverOverrides,
  };
  const fetchImpl = vi.fn(async () => Response.json({ labels: [] }));
  const server = createManagedPluginServer({
    serviceToken: token,
    redirectUri,
    drivers: async () => ({
      drivers: new Map([["gmail", driver]]),
      version: "v1",
    }),
    resolveDriver: async () => ({ driver, version: "v1" }),
    fetchImpl,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  disposals.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("address");
  const base = `http://127.0.0.1:${address.port}`;
  const call = (body: unknown, authorization = token) =>
    fetch(`${base}/v1/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${authorization}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });
  return { call, driver, fetchImpl, base };
}
describe("managed plugin boundary", () => {
  it.each([
    ["google_calendar", "calendar.readonly"],
    ["google_drive", "drive.metadata.readonly"],
    ["google_sheets", "spreadsheets.readonly"],
  ] as const)(
    "accepts equivalent Google email scopes for %s without granting missing permissions",
    async (connectorId, serviceScope) => {
      const scope = `https://www.googleapis.com/auth/${serviceScope}`;
      for (const [granted, expectedStatus] of [
        [`openid https://www.googleapis.com/auth/userinfo.email ${scope}`, 200],
        [`openid email ${scope}`, 200],
        ["openid https://www.googleapis.com/auth/userinfo.email", 403],
        [`openid ${scope}`, 403],
      ] as const) {
        const provider = new GoogleWorkspaceClient(
          connectorId,
          [scope],
          "client",
          "secret",
          vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
              Response.json({
                access_token: "test-access",
                refresh_token: "test-refresh",
                scope: granted,
              }),
            )
            .mockResolvedValueOnce(
              Response.json({ sub: "test-user", email: "reader@example.test" }),
            ),
        );
        const f = await fixture({
          connectorId,
          requiredScopes: provider.requiredScopes,
          exchangeCode: provider.exchangeCode.bind(provider),
        });
        const response = await f.call({
          pluginId: connectorId.replaceAll("_", "-"),
          action: "exchange",
          code: "test-code",
          codeVerifier: "v".repeat(43),
          redirectUri,
        });
        expect(response.status).toBe(expectedStatus);
        if (response.ok)
          expect(await response.json()).toMatchObject({
            account: { label: "reader@example.test" },
          });
      }
    },
  );
  it("requires host credentials and prevents redirect and provider substitution", async () => {
    const f = await fixture();
    expect(
      (await f.call({ pluginId: "gmail", action: "discover" }, "wrong")).status,
    ).toBe(401);
    expect(
      (
        await f.call({
          pluginId: "gmail",
          action: "authorize",
          redirectUri: "https://attacker.example/callback",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await f.call({
          pluginId: "gmail",
          action: "call",
          credential: { ...credential, connectorId: "github" },
        })
      ).status,
    ).toBe(403);
    expect(f.fetchImpl).not.toHaveBeenCalled();
    const invalid = await fetch(`${f.base}/v1/invoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: '{"credential":"private-token"',
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.text()).toBe('{"error":"invalid_request"}');
  });
  it("rejects partial consent and redacts provider failures", async () => {
    const f = await fixture({
      exchangeCode: vi.fn(async () => ({
        credential: { ...credential, scopes: [] },
      })),
    });
    const input = {
      pluginId: "gmail",
      action: "exchange",
      redirectUri,
      code: "private-code",
      codeVerifier: "v".repeat(43),
    };
    expect((await f.call(input)).status).toBe(403);
    vi.mocked(f.driver.exchangeCode).mockRejectedValueOnce(
      new Error("private-provider-token private-client-secret"),
    );
    const failure = await f.call(input);
    expect(failure.status).toBe(502);
    expect(await failure.text()).toBe('{"error":"provider_error"}');
  });
  it("discovers seven Gmail tools, runs a read, and never executes writes", async () => {
    const f = await fixture();
    const discovered = (await (
      await f.call({ pluginId: "gmail", action: "discover" })
    ).json()) as { tools: { name: string }[] };
    expect(discovered.tools).toHaveLength(7);
    const result = await f.call({
      pluginId: "gmail",
      action: "call",
      name: "gmail_list_labels",
      credential,
    });
    expect(result.status).toBe(200);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    const sent = await f.call({
      pluginId: "gmail",
      action: "call",
      name: "gmail_propose_send",
      credential,
    });
    expect(sent.status).toBe(403);
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });
});
it("reloads private OAuth configuration without restarting and pins old grants to their app", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oho-oauth-config-"));
  disposals.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "oauth.json");
  const versions = {
    v1: { gmail: { clientId: "first-app", clientSecret: "first-secret" } },
    v2: { gmail: { clientId: "second-app", clientSecret: "second-secret" } },
  };
  await writeFile(path, JSON.stringify({ activeVersion: "v1", versions }), {
    mode: 0o600,
  });
  const config = oauthConfiguration(path);
  const auth = {
    state: "s".repeat(43),
    codeChallenge: "c".repeat(43),
    redirectUri,
  };
  expect(
    (await config.resolve("gmail"))
      .driver!.authorizationUrl(auth)
      .searchParams.get("client_id"),
  ).toBe("first-app");
  await writeFile(path, JSON.stringify({ activeVersion: "v2", versions }));
  expect(
    (await config.resolve("gmail"))
      .driver!.authorizationUrl(auth)
      .searchParams.get("client_id"),
  ).toBe("second-app");
  expect(
    (await config.resolve("gmail", "v1"))
      .driver!.authorizationUrl(auth)
      .searchParams.get("client_id"),
  ).toBe("first-app");
  await chmod(path, 0o644);
  await expect(config.current()).rejects.toThrow("invalid_oauth_configuration");
});
