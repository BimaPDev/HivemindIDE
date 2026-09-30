/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE model catalog: every model the user can run, and which one suits a task.
 *
 *  Each route gets traits: how well it reasons, how fast and how costly it is,
 *  whether it can call tools, and what it is good at. They start from what the
 *  model's name says (a table of known families), are corrected by what
 *  HivemindIDE has observed (a model that turned out not to call tools, the
 *  response times it measured), and the user can override any of them.
 *
 *  Tasks (planning, coding, answering, sub-agent work, summarizing) weigh those
 *  traits differently; the best-scoring available route runs the task.
 *  Pure functions, so ranking can be tested without a workbench.
 *--------------------------------------------------------------------------------------------*/

export const TASKS = ['plan', 'code', 'ask', 'subagent', 'summarize'] as const;
export type TaskKind = typeof TASKS[number];

export type Level = 'low' | 'medium' | 'high';
export type CostLevel = 'free' | 'subscription' | 'low' | 'medium' | 'high';
export type ModelKind = 'local' | 'cli' | 'api';

export interface IModelTraits {
	readonly reasoning: Level;
	readonly speed: Level;
	readonly cost: CostLevel;
	/** Whether it can call tools, so run as an agent. Undefined: not known yet. */
	readonly tools?: boolean;
	readonly strengths: readonly TaskKind[];
}

export interface ICatalogEntry {
	readonly route: string;
	readonly provider: string;
	readonly model: string;
	readonly kind: ModelKind;
	readonly traits: IModelTraits;
	/** Where the traits came from, most specific last: `known`, `measured`, `user`. */
	readonly sources: readonly ('guess' | 'known' | 'measured' | 'user')[];
}

/** The picker entry that routes each turn by its task: `Auto/by task`. */
export const AUTO_PROVIDER = 'Auto';
export const AUTO_MODEL = 'by task';

// ---- What a model's name says ---------------------------------------------------------

interface IFamily {
	readonly match: RegExp;
	readonly reasoning: Level;
	readonly speed: Level;
	readonly cost: Exclude<CostLevel, 'free' | 'subscription'>;
	readonly tools?: boolean;
	readonly strengths: readonly TaskKind[];
}

/** First match wins, so the more specific names come first. */
const FAMILIES: readonly IFamily[] = [
	{ match: /opus/, reasoning: 'high', speed: 'low', cost: 'high', tools: true, strengths: ['plan', 'code'] },
	// Sonnet is the coding workhorse; Opus, the stronger reasoner, is the planner.
	{ match: /sonnet/, reasoning: 'high', speed: 'medium', cost: 'medium', tools: true, strengths: ['code'] },
	{ match: /haiku/, reasoning: 'medium', speed: 'high', cost: 'low', tools: true, strengths: ['subagent', 'summarize', 'ask'] },
	{ match: /gpt-?\d(\.\d+)?-?nano|gpt-?4o-mini/, reasoning: 'low', speed: 'high', cost: 'low', tools: true, strengths: ['summarize'] },
	{ match: /gpt-?\d(\.\d+)?-?mini|o\d-mini/, reasoning: 'medium', speed: 'high', cost: 'low', tools: true, strengths: ['subagent', 'ask'] },
	{ match: /gpt-?5|gpt-?4\.1|\bo[34]\b|codex/, reasoning: 'high', speed: 'medium', cost: 'medium', tools: true, strengths: ['plan', 'code'] },
	{ match: /gemini.*pro/, reasoning: 'high', speed: 'medium', cost: 'medium', tools: true, strengths: ['plan'] },
	{ match: /gemini.*flash/, reasoning: 'medium', speed: 'high', cost: 'low', tools: true, strengths: ['subagent', 'summarize'] },
	{ match: /coder|codestral|devstral/, reasoning: 'medium', speed: 'medium', cost: 'low', strengths: ['code', 'subagent'] },
	{ match: /(^|[^\d.])(0\.5|1\.5|1|2|3|4)b\b|tiny|small/, reasoning: 'low', speed: 'high', cost: 'low', strengths: ['summarize'] },
	{ match: /(^|[^\d.])(7|8|9|12|14)b\b/, reasoning: 'medium', speed: 'medium', cost: 'low', strengths: ['ask', 'subagent'] },
	{ match: /(^|[^\d.])(27|30|32|70|72)b\b/, reasoning: 'high', speed: 'low', cost: 'low', strengths: ['plan', 'code'] },
];

/** What is known before anything is measured. `cliDefault`: a CLI's own default model. */
export function guessTraits(model: string, kind: ModelKind, cliDefault = false): { traits: IModelTraits; known: boolean } {
	const name = model.toLowerCase();
	// A CLI's default is its maker's recommended model: capable and general. Not a
	// planning specialist: a CLI's strongest named model (opus, ...) plans better.
	const family = cliDefault
		? { reasoning: 'high' as const, speed: 'medium' as const, cost: 'medium' as const, tools: true, strengths: ['code'] as TaskKind[] }
		: FAMILIES.find(f => f.match.test(name));
	const cost: CostLevel = kind === 'local' ? 'free' : kind === 'cli' ? 'subscription' : family?.cost ?? 'medium';
	// Every agent CLI runs its own agent loop, so tools always work there.
	const tools = kind === 'cli' ? true : family?.tools;
	return {
		traits: { reasoning: family?.reasoning ?? 'medium', speed: family?.speed ?? 'medium', cost, tools, strengths: family?.strengths ?? ['ask'] },
		known: !!family,
	};
}

// ---- What HivemindIDE observed, and what the user set --------------------------------------

export interface IObserved {
	/** Seen to fail because it cannot call tools. */
	readonly toolless?: boolean;
	/** Average time of a successful request, with how many there were. */
	readonly averageMs?: number;
	readonly successes?: number;
}

export type ITraitOverrides = Partial<IModelTraits>;

/** Enough answers to trust a measured speed over a guessed one. */
const MEASURED_MIN = 3;

export function catalogEntry(route: { id: string; provider: string; model: string }, kind: ModelKind, observed: IObserved | undefined, overrides: ITraitOverrides | undefined, cliDefault = false): ICatalogEntry {
	const guess = guessTraits(route.model, kind, cliDefault);
	let traits = guess.traits;
	const sources: ICatalogEntry['sources'][number][] = [guess.known || cliDefault ? 'known' : 'guess'];
	if (observed?.toolless || (observed?.averageMs !== undefined && (observed.successes ?? 0) >= MEASURED_MIN)) {
		traits = {
			...traits,
			...(observed.toolless ? { tools: false } : {}),
			...(observed.averageMs !== undefined && (observed.successes ?? 0) >= MEASURED_MIN ? { speed: speedOf(observed.averageMs) } : {}),
		};
		sources.push('measured');
	}
	if (overrides && Object.keys(overrides).length) {
		traits = { ...traits, ...overrides };
		sources.push('user');
	}
	return { route: route.id, provider: route.provider, model: route.model, kind, traits, sources };
}

/** A whole agent turn, not a token rate: under 8 s is quick, over 30 s is slow. */
function speedOf(ms: number): Level {
	return ms < 8_000 ? 'high' : ms < 30_000 ? 'medium' : 'low';
}

// ---- Which model suits a task ------------------------------------------------------------

interface ITaskWeights {
	readonly reasoning: number;
	readonly speed: number;
	readonly cost: number;
	/** The task runs as an agent, so a model that cannot call tools cannot do it. */
	readonly tools: boolean;
}

const WEIGHTS: Record<TaskKind, ITaskWeights> = {
	// One request where quality decides: speed barely matters, and a subscription
	// already paid for beats spending per token.
	plan: { reasoning: 3, speed: 0.25, cost: 1, tools: false },
	code: { reasoning: 2, speed: 1, cost: 0.5, tools: true },
	ask: { reasoning: 1.5, speed: 1.5, cost: 1, tools: false },
	subagent: { reasoning: 1, speed: 2, cost: 1.5, tools: true },
	summarize: { reasoning: 0.5, speed: 2, cost: 2, tools: false },
};

const LEVEL: Record<Level, number> = { low: 0, medium: 1, high: 2 };
const COST: Record<CostLevel, number> = { free: 2, subscription: 1.5, low: 1.5, medium: 1, high: 0 };
const STRENGTH_BONUS = 1.5;
/** Tools not known yet: usable, but a model known to have them is preferred. */
const UNKNOWN_TOOLS_PENALTY = 1;

export interface IRanked {
	readonly entry: ICatalogEntry;
	readonly score: number;
}

/**
 * Every entry that can do `task`, best first. Entries `available` rejects
 * (resting, turned off) and ones that cannot call tools when the task needs
 * them are left out. Ties keep catalog order, which is the user's order.
 */
export function rankForTask(entries: readonly ICatalogEntry[], task: TaskKind, available: (route: string) => boolean = () => true): IRanked[] {
	const w = WEIGHTS[task];
	return entries
		.filter(e => available(e.route) && !(w.tools && e.traits.tools === false))
		.map((entry, i) => {
			const t = entry.traits;
			const score = w.reasoning * LEVEL[t.reasoning] + w.speed * LEVEL[t.speed] + w.cost * COST[t.cost]
				+ (t.strengths.includes(task) ? STRENGTH_BONUS : 0)
				- (w.tools && t.tools === undefined ? UNKNOWN_TOOLS_PENALTY : 0);
			return { entry, score, i };
		})
		.sort((a, b) => b.score - a.score || a.i - b.i)
		.map(({ entry, score }) => ({ entry, score }));
}

/** The task a chat request is: from its mode (Plan, Ask, ...) when it has one, else agent work. */
export function taskForMode(modeName: string | undefined): TaskKind {
	const name = (modeName ?? '').toLowerCase();
	return /plan|architect|design/.test(name) ? 'plan' : /ask|explain|question|review/.test(name) ? 'ask' : 'code';
}

/** A sub-agent task's kind, from the `[kind]` label the planner puts in front of it. */
export function parseTaskLabel(task: string): { kind: TaskKind; text: string } {
	const match = /^\s*\[(?<label>[a-z-]+)\]\s*(?<text>.*)$/i.exec(task);
	const label = match?.groups?.label.toLowerCase();
	const kind: TaskKind = label === 'plan' || label === 'design' ? 'plan'
		: label === 'code' || label === 'implement' || label === 'fix' || label === 'test' ? 'subagent'
			: label === 'research' || label === 'review' || label === 'explain' ? 'ask'
				: label === 'summarize' || label === 'docs' ? 'summarize'
					: 'subagent';
	return { kind, text: match?.groups?.text.trim() || task.trim() };
}

export function parseTraitOverrides(value: unknown): Record<string, ITraitOverrides> {
	const result: Record<string, ITraitOverrides> = {};
	if (!value || typeof value !== 'object') {
		return result;
	}
	const levels = ['low', 'medium', 'high'];
	const costs = ['free', 'subscription', 'low', 'medium', 'high'];
	for (const [route, raw] of Object.entries(value as Record<string, Record<string, unknown>>)) {
		if (!raw || typeof raw !== 'object') {
			continue;
		}
		const o: { -readonly [K in keyof IModelTraits]?: IModelTraits[K] } = {};
		if (levels.includes(raw.reasoning as string)) {
			o.reasoning = raw.reasoning as Level;
		}
		if (levels.includes(raw.speed as string)) {
			o.speed = raw.speed as Level;
		}
		if (costs.includes(raw.cost as string)) {
			o.cost = raw.cost as CostLevel;
		}
		if (typeof raw.tools === 'boolean') {
			o.tools = raw.tools;
		}
		if (Array.isArray(raw.strengths)) {
			o.strengths = raw.strengths.filter((s): s is TaskKind => TASKS.includes(s as TaskKind));
		}
		if (Object.keys(o).length) {
			result[route] = o;
		}
	}
	return result;
}
