import { createGoogleWorkspaceTools } from "../../../../providers/google-workspace/tools.js";
import type { ProviderService } from "../../../../runtime/service.js";

export function createTools(service: ProviderService) {
	return createGoogleWorkspaceTools(service).filter((tool) =>
		tool.manifest.id.startsWith("google_sheets."),
	);
}
