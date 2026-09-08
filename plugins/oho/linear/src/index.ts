import { createBusinessConnectorTools } from "../../../../providers/business/tools.js";
import type { ProviderService } from "../../../../runtime/service.js";

export function createTools(service: ProviderService) {
	return createBusinessConnectorTools(service).filter((tool) =>
		tool.manifest.id.startsWith("linear."),
	);
}
