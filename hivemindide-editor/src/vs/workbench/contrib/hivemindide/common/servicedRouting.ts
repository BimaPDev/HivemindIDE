/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE Serviced AI: combos and the usage they are routed by.
 *
 *  A combo is a named chain of routes with a strategy that decides which
 *  target a turn starts on; when that target fails, the turn moves to the
 *  next one in the order the strategy gave. Pure functions, so every
 *  strategy's order can be tested without a workbench.
 *--------------------------------------------------------------------------------------------*/

/** The provider name combos have in the route table: `Combo/<name>`. */
export const COMBO_PROVIDER = 'Combo';

export const COMBO_STRATEGIES = ['priority', 'round-robin', 'weighted', 'random', 'least-used', 'last-good', 'fastest'] as const;
export type ComboStrategy = typeof COMBO_STRATEGIES[number];

export interface IComboTarget {
	/** A route id, `provider/model`. */
	readonly route: string;
	/** For `weighted`: relative share of turns. Defaults to 1. */
	readonly weight?: number;
}

export interface ICombo {
	readonly name: string;
	readonly strategy: ComboStrategy;
	readonly targets: readonly IComboTarget[];
}

export function parseCombos(value: unknown): ICombo[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const seen = new Set<string>();
	const combos: ICombo[] = [];
	for (const entry of value) {
		const name = typeof entry?.name === 'string' ? entry.name.trim() : '';
		if (!name || seen.has(name)) {
			continue;
		}
		seen.add(name);
		const strategy = COMBO_STRATEGIES.includes(entry.strategy) ? entry.strategy as ComboStrategy : 'priority';
		const targets = (Array.isArray(entry.targets) ? entry.targets : [])
			.map((t: unknown) => typeof t === 'string' ? { route: t } : t)
			.filter((t: { route?: unknown }): t is IComboTarget => typeof t?.route === 'string' && !!t.route.trim())
			.map((t: IComboTarget) => typeof t.weight === 'number' && t.weight > 0 ? { route: t.route.trim(), weight: t.weight } : { route: t.route.trim() });
		combos.push({ name, strategy, targets });
	}
	return combos;
}

/** What a route has done, for the dashboard and for the usage-aware strategies. */
export interface IRouteStats {
	readonly requests: number;
	readonly failures: number;
	/** Total time of successful requests, for the average. */
	readonly okMs: number;
	readonly lastUsed?: number;
	readonly lastError?: string;
}

export const EMPTY_STATS: IRouteStats = { requests: 0, failures: 0, okMs: 0 };

export function recordOutcome(stats: IRouteStats | undefined, ok: boolean, ms: number, now: number, error?: string): IRouteStats {
	const s = stats ?? EMPTY_STATS;
	return {
		requests: s.requests + 1,
		failures: s.failures + (ok ? 0 : 1),
		okMs: s.okMs + (ok ? ms : 0),
		lastUsed: now,
		lastError: ok ? s.lastError : error?.slice(0, 300),
	};
}

/** Average time of a successful request, or undefined before the first one. */
export function averageMs(stats: IRouteStats | undefined): number | undefined {
	const ok = stats ? stats.requests - stats.failures : 0;
	return stats && ok > 0 ? stats.okMs / ok : undefined;
}

export interface IComboContext {
	readonly stats: (route: string) => IRouteStats | undefined;
	/** False for a route that is resting (cooldown) or no longer exists. */
	readonly available: (route: string) => boolean;
	/** Turns this combo has already started, for round-robin. */
	readonly turn: number;
	/** The target the combo's last successful turn ended on, for last-good. */
	readonly lastGood?: string;
	readonly random: () => number;
}

/**
 * The order a turn tries a combo's targets in: the first is where it starts, the
 * rest are where it goes when one fails. Resting targets go last, so they are
 * tried only when nothing else is left.
 */
export function orderComboTargets(combo: ICombo, ctx: IComboContext): string[] {
	const targets = [...new Map(combo.targets.map(t => [t.route, t])).values()];
	let ordered: IComboTarget[];
	switch (combo.strategy) {
		case 'round-robin': {
			const n = targets.length ? ctx.turn % targets.length : 0;
			ordered = [...targets.slice(n), ...targets.slice(0, n)];
			break;
		}
		case 'weighted': {
			const total = targets.reduce((sum, t) => sum + (t.weight ?? 1), 0);
			let pick = ctx.random() * total;
			const first = targets.find(t => (pick -= t.weight ?? 1) < 0) ?? targets[0];
			ordered = first ? [first, ...targets.filter(t => t !== first)] : [];
			break;
		}
		case 'random': {
			ordered = [...targets];
			for (let i = ordered.length - 1; i > 0; i--) {
				const j = Math.floor(ctx.random() * (i + 1));
				[ordered[i], ordered[j]] = [ordered[j], ordered[i]];
			}
			break;
		}
		case 'least-used':
			ordered = stableSort(targets, t => ctx.stats(t.route)?.requests ?? 0);
			break;
		case 'fastest':
			// Untried targets after measured ones: "fastest" is about what is known.
			ordered = stableSort(targets, t => averageMs(ctx.stats(t.route)) ?? Number.POSITIVE_INFINITY);
			break;
		case 'last-good': {
			const good = targets.find(t => t.route === ctx.lastGood);
			ordered = good ? [good, ...targets.filter(t => t !== good)] : targets;
			break;
		}
		default:
			ordered = targets;
	}
	const routes = ordered.map(t => t.route);
	return [...routes.filter(r => ctx.available(r)), ...routes.filter(r => !ctx.available(r))];
}

function stableSort<T>(items: readonly T[], key: (item: T) => number): T[] {
	return items.map((item, i) => ({ item, i, k: key(item) })).sort((a, b) => a.k - b.k || a.i - b.i).map(x => x.item);
}
