import { GmailClient } from "../plugins/oho/gmail/src/client.js";
import { GmailOAuthDriver } from "../plugins/oho/gmail/src/oauth.js";
import { GitHubClient } from "../plugins/oho/github/src/client.js";
import { SlackClient } from "../plugins/oho/slack/src/client.js";
import { NotionClient } from "../plugins/oho/notion/src/client.js";
import { GoogleWorkspaceClient } from "../providers/google-workspace/client.js";
import { LarkClient } from "../providers/lark/client.js";
import type { ConnectorOAuthDriver } from "./oauth.js";
import {
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_DRIVE_SCOPES,
  GOOGLE_SHEETS_SCOPES,
} from "./provider-metadata.js";

// Operator configuration only. App secrets never belong in public manifests.
export function createOAuthDrivers(
  config: Record<string, { clientId?: string; clientSecret?: string }>,
  fetchImpl = fetch,
): Map<string, ConnectorOAuthDriver> {
  const credentials = (id: string) => config[id] ?? {};
  return new Map<string, ConnectorOAuthDriver>([
    [
      "gmail",
      new GmailOAuthDriver(
        new GmailClient(fetchImpl),
        credentials("gmail").clientId,
        credentials("gmail").clientSecret,
        ["https://www.googleapis.com/auth/gmail.readonly"],
      ),
    ],
    [
      "google-calendar",
      new GoogleWorkspaceClient(
        "google_calendar",
        GOOGLE_CALENDAR_SCOPES,
        credentials("google-calendar").clientId,
        credentials("google-calendar").clientSecret,
        fetchImpl,
      ),
    ],
    [
      "google-drive",
      new GoogleWorkspaceClient(
        "google_drive",
        GOOGLE_DRIVE_SCOPES,
        credentials("google-drive").clientId,
        credentials("google-drive").clientSecret,
        fetchImpl,
      ),
    ],
    [
      "google-sheets",
      new GoogleWorkspaceClient(
        "google_sheets",
        GOOGLE_SHEETS_SCOPES,
        credentials("google-sheets").clientId,
        credentials("google-sheets").clientSecret,
        fetchImpl,
      ),
    ],
    [
      "github",
      new GitHubClient(
        credentials("github").clientId,
        credentials("github").clientSecret,
        fetchImpl,
      ),
    ],
    ["slack", new SlackClient(credentials("slack").clientId, fetchImpl)],
    [
      "notion",
      new NotionClient(
        credentials("notion").clientId,
        credentials("notion").clientSecret,
        fetchImpl,
      ),
    ],
    [
      "feishu",
      new LarkClient(
        credentials("feishu").clientId,
        credentials("feishu").clientSecret,
        fetchImpl,
        undefined,
        "feishu",
      ),
    ],
    [
      "lark",
      new LarkClient(
        credentials("lark").clientId,
        credentials("lark").clientSecret,
        fetchImpl,
      ),
    ],
  ]);
}
