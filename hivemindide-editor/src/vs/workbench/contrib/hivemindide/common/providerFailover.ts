/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE provider failover: which failures move a chat to another provider.
 *
 *  Pure functions and one small state class, so they can be tested from node
 *  without a workbench. A failure crosses the IPC boundary as the error string
 *  the model server produced, so classification works on that text: the HTTP
 *  status the main process puts in front of it, and the phrases providers use
 *  in their error bodies.
 *--------------------------------------------------------------------------------------------*/

/** What the user chose to happen when a provider runs out. */
export type FailoverMode = 'ask' | 'auto' | 'off';

export function toFailoverMode(value: unknown): FailoverMode {
	return value === 'auto' || value === 'off' ? value : 'ask';
}

/** A backup provider as it is stored in settings. Its API key lives in secret storage. */
export interface IFailoverProvider {
	/** Unique, user-chosen: "Anthropic", "OpenRouter", "Work OpenAI". */
	readonly name: string;
	/** Base URL of an OpenAI-compatible API, e.g. `https://api.openai.com/v1`. */
	readonly url: string;
	readonly model: string;
	/** More models on the same provider, offered as hivemind shell routes. `model` stays the failover choice. */
	readonly models?: readonly string[];
	/** False takes it out of routing and failover without forgetting it. */
	readonly enabled?: boolean;
}

export function parseFailoverProviders(value: unknown): IFailoverProvider[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set<string>();
	const providers: IFailoverProvider[] = [];
	for (const entry of value) {
		const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
		const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
		const model = typeof entry?.model === 'string' ? entry.model.trim() : '';
		if (name && url && model && !seen.has(name)) {
			seen.add(name);
			const models = Array.isArray(entry.models) ? entry.models.filter((m: unknown): m is string => typeof m === 'string' && !!m.trim()).map((m: string) => m.trim()) : [];
			providers.push({ name, url, model, ...(models.length ? { models } : {}), ...(entry.enabled === false ? { enabled: false } : {}) });
		}
	}
	return providers;
}

export const enum ProviderFailureKind {
	/** Out of credit or over a usage cap: waiting minutes will not help. */
	Quota = 'quota',
	/** Too many requests right now. */
	RateLimit = 'rateLimit',
	/** Key missing, wrong or revoked. */
	Auth = 'auth',
	/** The provider is down or overloaded. */
	Unavailable = 'unavailable',
	/** Anything else: a bad request, a prompt too long, a network blip. Not a reason to switch. */
	Other = 'other',
}

export interface IProviderFailure {
	readonly kind: ProviderFailureKind;
	/** How long the provider asked us to wait, when it said. */
	readonly retryAfterMs?: number;
	readonly message: string;
}

/**
 * The model cannot call tools, so it cannot run as an agent: Ollama's "does not
 * support tools", llama.cpp's "tools param requires --jinja", and the "tool use
 * is not supported" other OpenAI-compatible servers send. Not a provider failure:
 * the same model can still answer without tools.
 */
export function isToolSupportError(message: string): boolean {
	return /does not support tools|tools? (?:use |calling )?(?:is |are )?not supported|tools param requires/i.test(message);
}

/** Failures where another provider can do what this one cannot. */
export function isFailoverReason(kind: ProviderFailureKind): boolean {
	return kind !== ProviderFailureKind.Other;
}

const QUOTA = /insufficient[_ ]quota|exceeded your (current )?quota|credit balance|out of credits?|billing|payment required|usage limit|spend(ing)? limit/i;
const RATE_LIMIT = /rate[_ ]?limit|too many requests|per (minute|min|second)\b|\b(rpm|tpm)\b/i;
/** Bare "quota" is a cap only when nothing says it is a per-minute one. */
const SOFT_QUOTA = /\bquota\b|resource[_ ]exhausted/i;
const AUTH = /invalid[_ ](api[_ ])?key|incorrect api key|authentication|unauthori[sz]ed|permission denied|api key (is )?(missing|invalid|not valid)|not (signed|logged) in/i;
/** Also a service that cannot be reached at all: refused, unresolvable, or the connection dropped. */
const UNAVAILABLE = /overloaded|service unavailable|bad gateway|gateway timeout|temporarily unavailable|server is busy|connection (?:error|refused)|lost the connection|econnrefused|enotfound|fetch failed/i;

/** Sorts a model-server error into a failure kind, reading any wait it asked for. */
export function classifyProviderError(message: string): IProviderFailure {
	const status = Number(/\bHTTP (?<status>\d{3})\b/.exec(message)?.groups?.status);
	const retryAfterMs = parseRetryAfter(message);
	let kind: ProviderFailureKind;
	// Quota wording wins over the status: OpenAI reports an empty balance as a 429.
	if (status === 402 || QUOTA.test(message)) {
		kind = ProviderFailureKind.Quota;
	} else if (RATE_LIMIT.test(message)) {
		kind = ProviderFailureKind.RateLimit;
	} else if (SOFT_QUOTA.test(message)) {
		kind = ProviderFailureKind.Quota;
	} else if (status === 429) {
		kind = ProviderFailureKind.RateLimit;
	} else if (status === 401 || status === 403 || AUTH.test(message)) {
		kind = ProviderFailureKind.Auth;
	} else if (status === 500 || status === 502 || status === 503 || status === 504 || status === 529 || UNAVAILABLE.test(message)) {
		kind = ProviderFailureKind.Unavailable;
	} else {
		kind = ProviderFailureKind.Other;
	}
	return { kind, retryAfterMs, message };
}

/**
 * The wait a provider asked for: the `retry after Ns` the main process adds from
 * the Retry-After header, or "try again in 1m30s" / "in 20.5s" / "in 450ms" in the body.
 */
export function parseRetryAfter(message: string): number | undefined {
	const header = /retry after (?<seconds>\d+(?:\.\d+)?)s\b/i.exec(message)?.groups?.seconds;
	if (header) {
		return Math.round(Number(header) * 1000);
	}
	const body = /try again in (?<wait>(?:\d+(?:\.\d+)?\s*(?:ms|h|m|s)\s*)+)/i.exec(message)?.groups?.wait;
	if (!body) {
		return undefined;
	}
	const unitMs: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
	let ms = 0;
	for (const part of body.matchAll(/(?<amount>\d+(?:\.\d+)?)\s*(?<unit>ms|h|m|s)/gi)) {
		ms += Number(part.groups?.amount) * unitMs[part.groups?.unit.toLowerCase() ?? 's'];
	}
	return ms > 0 ? Math.round(ms) : undefined;
}

/** How long a provider is skipped when it did not say. */
const DEFAULT_COOLDOWN_MS: Record<ProviderFailureKind, number> = {
	[ProviderFailureKind.Quota]: 60 * 60_000,
	[ProviderFailureKind.RateLimit]: 60_000,
	// Until the key is fixed; setting a key clears it sooner.
	[ProviderFailureKind.Auth]: 24 * 60 * 60_000,
	[ProviderFailureKind.Unavailable]: 2 * 60_000,
	[ProviderFailureKind.Other]: 0,
};

export interface IProviderCooldown {
	readonly until: number;
	readonly failure: IProviderFailure;
}

/**
 * Providers that recently ran out, and until when. Kept in memory: a restart
 * tries everything again, which costs at most one failed request per provider.
 */
export class ProviderCooldowns {

	private readonly entries = new Map<string, IProviderCooldown>();

	mark(provider: string, failure: IProviderFailure, now = Date.now()): IProviderCooldown | undefined {
		const ms = failure.retryAfterMs ?? DEFAULT_COOLDOWN_MS[failure.kind];
		if (ms <= 0) {
			return undefined;
		}
		const cooldown = { until: now + ms, failure };
		this.entries.set(provider, cooldown);
		return cooldown;
	}

	get(provider: string, now = Date.now()): IProviderCooldown | undefined {
		const entry = this.entries.get(provider);
		if (entry && entry.until <= now) {
			this.entries.delete(provider);
			return undefined;
		}
		return entry;
	}

	clear(provider?: string): void {
		if (provider === undefined) {
			this.entries.clear();
		} else {
			this.entries.delete(provider);
		}
	}

	/** Every provider still cooling down, soonest back first. */
	active(now = Date.now()): [string, IProviderCooldown][] {
		return [...this.entries.keys()]
			.map(name => [name, this.get(name, now)] as const)
			.filter((e): e is [string, IProviderCooldown] => !!e[1])
			.sort((a, b) => a[1].until - b[1].until);
	}
}

/** Backups to offer, in the user's order: not the one that just failed, not one still cooling down. */
export function availableFallbacks(providers: readonly IFailoverProvider[], failed: ReadonlySet<string>, cooldowns: ProviderCooldowns, now = Date.now()): IFailoverProvider[] {
	return providers.filter(p => !failed.has(p.name) && !cooldowns.get(p.name, now));
}

/** "quota", "a rate limit" … for sentences like "Anthropic hit a rate limit". */
export function describeFailure(failure: IProviderFailure): string {
	switch (failure.kind) {
		case ProviderFailureKind.Quota: return 'ran out of quota';
		case ProviderFailureKind.RateLimit: return 'hit a rate limit';
		case ProviderFailureKind.Auth: return 'rejected its API key';
		case ProviderFailureKind.Unavailable: return 'is unavailable';
		default: return 'failed';
	}
}

/** "in 40 min", "in 25 s", "in 3 h": when a cooldown ends. */
export function formatWait(ms: number): string {
	if (ms >= 90 * 60_000) {
		return `in ${Math.round(ms / 3_600_000)} h`;
	}
	if (ms >= 60_000) {
		return `in ${Math.round(ms / 60_000)} min`;
	}
	return `in ${Math.max(1, Math.round(ms / 1000))} s`;
}
