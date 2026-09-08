import { createFeishuTools } from "../../../../providers/lark/tools.js";
import type { ProviderService } from "../../../../runtime/service.js";

export function createTools(service: ProviderService) {
	return createFeishuTools(service).filter((tool) =>
		tool.manifest.id.startsWith("feishu."),
	);
}
