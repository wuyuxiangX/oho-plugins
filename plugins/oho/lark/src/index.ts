import { createLarkTools } from "../../../../providers/lark/tools.js";
import type { ProviderService } from "../../../../runtime/service.js";

export function createTools(service: ProviderService) {
	return createLarkTools(service).filter((tool) =>
		tool.manifest.id.startsWith("lark."),
	);
}
