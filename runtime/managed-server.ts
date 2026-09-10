import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import type { ConnectorOAuthDriver } from "./oauth.js";
import { createPluginTools, pluginIds } from "./plugins.js";
import { ProviderService } from "./service.js";

const credentialSchema = z.object({
  schemaVersion: z.literal("connector.oauth.v1"),
  connectorId: z.string(),
  oauthConfigVersion: z.string().max(80).optional(),
  accessToken: z.string().min(1).max(16384),
  refreshToken: z.string().max(16384).optional(),
  expiresAt: z.iso.datetime().optional(),
  refreshTokenExpiresAt: z.iso.datetime().optional(),
  scopes: z.array(z.string()).max(100),
});
const requestSchema = z
  .object({
    pluginId: z.enum(pluginIds),
    action: z.enum([
      "authorize",
      "exchange",
      "refresh",
      "revoke",
      "discover",
      "call",
    ]),
    oauthConfigVersion: z.string().max(80).optional(),
    state: z.string().min(32).max(128).optional(),
    redirectUri: z.url().optional(),
    codeChallenge: z
      .string()
      .regex(/^[\w-]{43}$/)
      .optional(),
    code: z.string().min(1).max(8192).optional(),
    codeVerifier: z.string().min(43).max(128).optional(),
    credential: credentialSchema.optional(),
    name: z.string().max(128).optional(),
    arguments: z.unknown().optional(),
  })
  .strict();

/** Private, stateless service: Oho owns user binding, state, custody and refresh locks. */
export function createManagedPluginServer(input: {
  serviceToken: string;
  redirectUri: string;
  drivers: () => Promise<{
    drivers: Map<string, ConnectorOAuthDriver>;
    version: string;
  }>;
  resolveDriver: (
    pluginId: string,
    version?: string,
  ) => Promise<{ driver: ConnectorOAuthDriver | undefined; version: string }>;
  fetchImpl?: typeof fetch;
}) {
  if (input.serviceToken.length < 32)
    throw new Error("managed_service_token_required");
  const digest = (s: string) => createHash("sha256").update(s).digest();
  const expected = digest(`Bearer ${input.serviceToken}`);
  let active = 0;
  const server = createServer(async (req, res) => {
    const reply = (status: number, body: unknown) => {
      const data = JSON.stringify(body);
      res
        .writeHead(Buffer.byteLength(data) > 1_048_576 ? 502 : status, {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        })
        .end(
          Buffer.byteLength(data) > 1_048_576
            ? '{"error":"response_too_large"}'
            : data,
        );
    };
    // This is never a browser API. Deploy behind TLS and a private network.
    if (
      req.headers.origin ||
      !timingSafeEqual(expected, digest(req.headers.authorization ?? ""))
    )
      return reply(401, { error: "unauthorized" });
    if (req.method === "GET" && req.url === "/v1/plugins") {
      const configured = await input
        .drivers()
        .catch(() => ({ drivers: new Map<string, ConnectorOAuthDriver>() }));
      return reply(200, {
        plugins: [...configured.drivers].map(([id, driver]) => ({
          ref: `oho/${id}`,
          configured: driver.configured,
          pkce: driver.pkce,
        })),
      });
    }
    if (req.method !== "POST" || req.url !== "/v1/invoke")
      return reply(404, { error: "not_found" });
    if (!req.headers["content-type"]?.startsWith("application/json"))
      return reply(415, { error: "invalid_content_type" });
    if (active >= 32) return reply(429, { error: "rate_limited" });
    active++;
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableEnded) controller.abort();
    });
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(30_000),
    ]);
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 1_048_576) return reply(413, { error: "request_too_large" });
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return reply(400, { error: "invalid_request" });
      }
      const parsed = requestSchema.safeParse(body);
      if (!parsed.success) return reply(400, { error: "invalid_request" });
      const value = parsed.data;
      const { driver, version: oauthConfigVersion } = await input.resolveDriver(
        value.pluginId,
        value.oauthConfigVersion ?? value.credential?.oauthConfigVersion,
      );
      if (!driver?.configured)
        return reply(503, { error: "oauth_not_configured" });
      if (value.redirectUri && value.redirectUri !== input.redirectUri)
        return reply(400, { error: "invalid_redirect" });
      const credential = value.credential;
      if (credential && credential.connectorId !== driver.connectorId)
        return reply(403, { error: "credential_binding_mismatch" });
      if (value.action === "authorize") {
        if (!value.state || !value.codeChallenge || !value.redirectUri)
          return reply(400, { error: "invalid_request" });
        return reply(200, {
          url: driver.authorizationUrl({
            state: value.state,
            codeChallenge: value.codeChallenge,
            redirectUri: value.redirectUri,
          }).href,
          oauthConfigVersion,
        });
      }
      if (value.action === "exchange") {
        if (!value.code || !value.codeVerifier || !value.redirectUri)
          return reply(400, { error: "invalid_request" });
        const grant = await driver.exchangeCode({
          code: value.code,
          codeVerifier: value.codeVerifier,
          redirectUri: value.redirectUri,
          signal,
        });
        if (
          !driver.requiredScopes.every((scope) =>
            grant.credential.scopes.includes(scope),
          )
        )
          return reply(403, { error: "insufficient_scope" });
        return reply(200, {
          ...grant,
          credential: { ...grant.credential, oauthConfigVersion },
        });
      }
      if (value.action === "refresh" || value.action === "revoke") {
        if (!credential) return reply(400, { error: "invalid_request" });
        const bound = { ...credential, connectorId: driver.connectorId };
        if (value.action === "revoke") {
          await driver.revokeCredential?.(bound, signal);
          return reply(200, { revoked: true });
        }
        if (!driver.refreshToken || !bound.refreshToken)
          return reply(401, { error: "auth_required" });
        return reply(200, {
          ...(await driver.refreshToken(bound, signal)),
          oauthConfigVersion,
        });
      }
      const userId = randomUUID(),
        connectionId = randomUUID();
      const tools = createPluginTools(
        value.pluginId,
        new ProviderService(async (binding) => {
          if (
            !credential ||
            binding.userId !== userId ||
            binding.connectionId !== connectionId ||
            binding.connectorId !== driver.connectorId
          )
            throw new Error("auth_required");
          return {
            accessToken: credential.accessToken,
            expiresAt: credential.expiresAt,
            version: "managed",
          };
        }, input.fetchImpl),
      );
      if (value.action === "discover")
        return reply(200, {
          protocolVersion: "2025-06-18",
          serverInfo: { name: `oho-${value.pluginId}`, version: "1.0.0" },
          tools: tools.map(({ manifest: m }) => ({
            name: m.runtimeName,
            title: m.label,
            description: m.description,
            inputSchema: m.inputSchema,
            outputSchema: m.outputSchema,
          })),
        });
      const tool = tools.find((t) => t.manifest.runtimeName === value.name);
      if (!tool) return reply(400, { error: "unknown_tool" });
      if (tool.manifest.sideEffect !== "none")
        return reply(403, { error: "approval_host_required" });
      const args = tool.inputValidator.safeParse(value.arguments ?? {});
      if (!args.success) return reply(400, { error: "invalid_arguments" });
      const output = tool.outputValidator.parse(
        await tool.execute(args.data, {
          userId,
          agentConnectionId: connectionId,
          runId: randomUUID(),
          toolCallId: randomUUID(),
          operationId: tool.manifest.id,
          policyHash: tool.manifest.schemaHash,
          defaultTimeZone: "UTC",
          signal,
        }),
      );
      return reply(200, {
        structuredContent: output,
        content: [
          {
            type: "text",
            text: tool.toModelContent?.(output) ?? JSON.stringify(output),
          },
        ],
      });
    } catch (error) {
      const failure = error as {
        code?: string;
        status?: number;
        cause?: { code?: string };
      };
      const network = [
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_SOCKET",
        "ETIMEDOUT",
        "ECONNRESET",
        "ECONNREFUSED",
        "ENOTFOUND",
        "EAI_AGAIN",
      ].includes(failure.cause?.code ?? failure.code ?? "");
      // Never serialize provider error messages, response bodies or submitted arguments.
      const auth =
        failure.code === "invalid_grant" ||
        failure.code === "auth_required" ||
        failure.status === 401;
      return reply(auth ? 401 : signal.aborted ? 504 : 502, {
        error: auth
          ? "auth_required"
          : signal.aborted
            ? "timeout"
            : network
              ? "network_error"
              : "provider_error",
      });
    } finally {
      active--;
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  return server;
}
