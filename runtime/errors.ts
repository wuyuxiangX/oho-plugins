export class ConnectorServiceError extends Error {
	constructor(
		readonly code: string,
		readonly status: 400 | 403 | 404 | 409 | 410 | 500 | 502 | 503,
		message: string,
	) {
		super(message);
		this.name = "ConnectorServiceError";
	}
}
export class ProposalServiceError extends Error {}
