/*---------------------------------------------------------------------------------------------
 *  Types for locally-read AI assistant usage.
 *--------------------------------------------------------------------------------------------*/

/** One provider's usage as far as local data can tell us. */
export interface IProviderUsage {
	readonly providerId: string;
	readonly providerLabel: string;

	/** Tokens attributed to `date`, summed across models. */
	readonly tokens: number;

	/** ISO date (YYYY-MM-DD) the figures belong to. */
	readonly date: string;

	/**
	 * True when `date` is not today — the local data has not been refreshed since.
	 * Rendering a stale figure as though it were today's is the main way an
	 * indicator like this lies to you, so callers must surface it.
	 */
	readonly stale: boolean;

	/** Per-model token breakdown for the tooltip. */
	readonly byModel: ReadonlyArray<{ readonly model: string; readonly tokens: number }>;

	/** Estimated spend, when the local data reports it. Often 0, meaning "not reported". */
	readonly costUSD: number;

	readonly sessionCount: number;
	readonly messageCount: number;
}

export interface IUsageSnapshot {
	readonly providers: readonly IProviderUsage[];
	/** Set when no provider produced data, explaining why for the tooltip. */
	readonly unavailableReason?: string;
}

export function totalTokens(snapshot: IUsageSnapshot): number {
	return snapshot.providers.reduce((sum, p) => sum + p.tokens, 0);
}

/** 1234 -> "1.2k", 1234567 -> "1.2M". Keeps the status bar entry narrow. */
export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) {
		return `${(tokens / 1_000_000).toFixed(1)}M`;
	}
	if (tokens >= 1_000) {
		return `${(tokens / 1_000).toFixed(1)}k`;
	}
	return String(tokens);
}
