/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE usage notch: how much of each assistant's plan limit is gone.
 *
 *  No vendor publishes "your session limit is N% used" as an API, so every
 *  figure here comes from what the tools already record on this machine:
 *  Codex writes a rate-limit snapshot into each session log, and Claude Code
 *  reports its limit state while it runs a turn. Nothing is fetched and no
 *  credential is read.
 *
 *  Pure functions only (parsing, severity, when to alert) so they can be
 *  tested without a workbench.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';

/** One limit window of a provider's plan: the 5-hour session, the week… */
export interface IUsageWindow {
	/** Stable within a provider: `five_hour`, `seven_day`, `primary`… */
	readonly id: string;
	readonly label: string;
	/**
	 * 0–100, or undefined when the source confirmed the window but not how full
	 * it is. Claude Code only states a percentage once usage nears the limit.
	 */
	readonly usedPercent: number | undefined;
	/** Epoch ms at which the window starts over. */
	readonly resetsAt?: number;
	/** The source said this window is refusing requests. */
	readonly exhausted?: boolean;
}

export interface IProviderLimits {
	readonly id: string;
	readonly label: string;
	/** One or two letters drawn inside the ring. */
	readonly glyph: string;
	readonly windows: readonly IUsageWindow[];
	/**
	 * Epoch ms of the reading, or undefined before the first one. Usage only
	 * grows inside a window, so an old reading is a floor for the current
	 * figure rather than a guess at it.
	 */
	readonly observedAt?: number;
	/** Where the figures came from, for the card. */
	readonly source: string;
}

export const enum UsageSeverity {
	Unknown = 'unknown',
	Ok = 'ok',
	Elevated = 'elevated',
	High = 'high',
	Critical = 'critical',
}

const SEVERITY_ORDER: readonly UsageSeverity[] = [UsageSeverity.Unknown, UsageSeverity.Ok, UsageSeverity.Elevated, UsageSeverity.High, UsageSeverity.Critical];

export function severityOf(percent: number | undefined): UsageSeverity {
	if (percent === undefined) {
		return UsageSeverity.Unknown;
	}
	if (percent >= 90) {
		return UsageSeverity.Critical;
	}
	if (percent >= 70) {
		return UsageSeverity.High;
	}
	if (percent >= 50) {
		return UsageSeverity.Elevated;
	}
	return UsageSeverity.Ok;
}

export function worstSeverity(severities: Iterable<UsageSeverity>): UsageSeverity {
	let worst = UsageSeverity.Unknown;
	for (const s of severities) {
		if (SEVERITY_ORDER.indexOf(s) > SEVERITY_ORDER.indexOf(worst)) {
			worst = s;
		}
	}
	return worst;
}

/** The percentage to draw: an exhausted window is full whatever else was said. */
export function effectivePercent(window: IUsageWindow): number | undefined {
	return window.exhausted ? 100 : window.usedPercent;
}

/**
 * Windows that have not reset yet. Once a window resets its old percentage is
 * no longer true, and the new one is unknown until the tool reports again.
 */
export function liveWindows(provider: IProviderLimits, now: number): IUsageWindow[] {
	return provider.windows.filter(w => w.resetsAt === undefined || w.resetsAt > now);
}

/** The window closest to cutting the user off: the one the ring shows. */
export function headlineWindow(provider: IProviderLimits, now: number): IUsageWindow | undefined {
	const live = liveWindows(provider, now);
	let best: IUsageWindow | undefined;
	for (const w of live) {
		const p = effectivePercent(w);
		if (p !== undefined && (best === undefined || p > (effectivePercent(best) ?? -1))) {
			best = w;
		}
	}
	return best ?? live[0];
}

// ---- Codex ------------------------------------------------------------------------

type Json = Record<string, unknown>;

/**
 * The rate-limit snapshot in one line of a Codex session log
 * (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`), from its `token_count` events.
 *
 * Codex has written this three ways: nested windows with `resets_at` (epoch
 * seconds), nested windows with `resets_in_seconds` (relative to the line's
 * timestamp), and early flat `primary_used_percent` fields. All are read.
 */
export function parseCodexRateLimits(line: string): { readonly observedAt: number; readonly windows: IUsageWindow[] } | undefined {
	if (!line.includes('rate_limits')) {
		return undefined;
	}
	let entry: Json;
	try {
		entry = JSON.parse(line);
	} catch {
		return undefined;
	}
	const payload = asObject(entry?.payload);
	const limits = asObject(payload?.rate_limits);
	if (!payload || payload.type !== 'token_count' || !limits) {
		return undefined;
	}
	const observedAt = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
	if (isNaN(observedAt)) {
		return undefined;
	}

	const windows: IUsageWindow[] = [];
	for (const key of ['primary', 'secondary'] as const) {
		const nested = asObject(limits[key]);
		const flatPercent = limits[`${key}_used_percent`];
		const usedPercent = nested ? nested.used_percent : flatPercent;
		if (typeof usedPercent !== 'number') {
			continue;
		}
		const minutes = nested ? nested.window_minutes : limits[`${key}_window_minutes`];
		windows.push({
			id: key,
			label: codexWindowLabel(typeof minutes === 'number' ? minutes : undefined, key),
			usedPercent: clampPercent(usedPercent),
			resetsAt: nested ? codexResetsAt(nested, observedAt) : undefined,
		});
	}
	return windows.length ? { observedAt, windows } : undefined;
}

function codexResetsAt(window: Json, observedAt: number): number | undefined {
	if (typeof window.resets_at === 'number') {
		return window.resets_at * 1000;
	}
	if (typeof window.resets_at === 'string') {
		const at = Date.parse(window.resets_at);
		return isNaN(at) ? undefined : at;
	}
	if (typeof window.resets_in_seconds === 'number') {
		return observedAt + window.resets_in_seconds * 1000;
	}
	return undefined;
}

function codexWindowLabel(minutes: number | undefined, key: 'primary' | 'secondary'): string {
	if (minutes === undefined) {
		return key === 'primary'
			? localize('usageLimits.codex.primary', "Short-term limit")
			: localize('usageLimits.codex.secondary', "Weekly limit");
	}
	return windowLabelForMinutes(minutes);
}

/** 300 -> "5-hour limit", 10080 -> "Weekly limit". Windows are reported a minute or two short. */
export function windowLabelForMinutes(minutes: number): string {
	const near = (target: number) => Math.abs(minutes - target) <= target * 0.02 + 2;
	if (near(7 * 24 * 60)) {
		return localize('usageLimits.weekly', "Weekly limit");
	}
	if (near(24 * 60)) {
		return localize('usageLimits.daily', "Daily limit");
	}
	if (minutes < 24 * 60) {
		return localize('usageLimits.hours', "{0}-hour limit", Math.max(1, Math.round(minutes / 60)));
	}
	return localize('usageLimits.days', "{0}-day limit", Math.round(minutes / (24 * 60)));
}

// ---- Claude Code ------------------------------------------------------------------

export interface IClaudeLimitReport {
	readonly rejected: boolean;
	readonly limitType?: string;
	/** Seconds since the epoch. */
	readonly resetsAt?: number;
	/** Fraction 0–1, as in the `anthropic-ratelimit-unified-*-utilization` headers. */
	readonly utilization?: number;
}

/**
 * Folds one `rate_limit_event` from Claude Code into the windows already known.
 * A report without a percentage keeps the last one for the same window: usage
 * has not gone down, so the old figure is still a true floor.
 */
export function applyClaudeLimit(windows: readonly IUsageWindow[], report: IClaudeLimitReport): IUsageWindow[] {
	const id = report.limitType ?? 'unknown';
	const resetsAt = report.resetsAt !== undefined ? report.resetsAt * 1000 : undefined;
	const previous = windows.find(w => w.id === id);
	const reported = report.utilization !== undefined ? clampPercent(report.utilization <= 1 ? report.utilization * 100 : report.utilization) : undefined;
	const carried = previous && sameReset(previous.resetsAt, resetsAt) ? previous.usedPercent : undefined;
	const next: IUsageWindow = {
		id,
		label: claudeWindowLabel(id),
		usedPercent: report.rejected ? 100 : reported ?? carried,
		resetsAt,
		exhausted: report.rejected || undefined,
	};
	return [...windows.filter(w => w.id !== id), next].sort((a, b) => claudeWindowOrder(a.id) - claudeWindowOrder(b.id));
}

const CLAUDE_WINDOWS = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'overage'];

function claudeWindowOrder(id: string): number {
	const i = CLAUDE_WINDOWS.indexOf(id);
	return i < 0 ? CLAUDE_WINDOWS.length : i;
}

function claudeWindowLabel(id: string): string {
	switch (id) {
		case 'five_hour': return localize('usageLimits.claude.session', "Current session");
		case 'seven_day': return localize('usageLimits.claude.week', "All models");
		case 'seven_day_opus': return localize('usageLimits.claude.opus', "Opus this week");
		case 'seven_day_sonnet': return localize('usageLimits.claude.sonnet', "Sonnet this week");
		case 'overage': return localize('usageLimits.claude.overage', "Extra usage");
		default: return id.replace(/_/g, ' ');
	}
}

// ---- Alerts -----------------------------------------------------------------------

/** Per window: which reset it belongs to and the highest threshold already alerted. */
export interface IAlertMark {
	readonly resetsAt?: number;
	readonly level: number;
}

/**
 * Whether crossing into `window`'s current usage deserves an alert, and the
 * mark to remember. Each threshold alerts once per window; a jump straight
 * past several alerts once, for the highest. A new reset time, or usage lower
 * than the level already alerted, means the window started over.
 */
export function nextAlert(mark: IAlertMark | undefined, window: IUsageWindow, thresholds: readonly number[]): { readonly alert?: number; readonly mark: IAlertMark | undefined } {
	const percent = effectivePercent(window);
	const continues = !!mark && sameReset(mark.resetsAt, window.resetsAt);
	if (percent === undefined) {
		return { mark: continues ? mark : undefined };
	}
	const alerted = continues && percent >= mark!.level ? mark!.level : 0;
	const crossed = thresholds.reduce((max, t) => percent >= t && t > max ? t : max, 0);
	return crossed > alerted
		? { alert: crossed, mark: { resetsAt: window.resetsAt, level: crossed } }
		: { mark: { resetsAt: window.resetsAt, level: alerted } };
}

/** Reset times computed from relative seconds drift between readings; half an hour apart is a different window. */
function sameReset(a: number | undefined, b: number | undefined): boolean {
	if (a === undefined || b === undefined) {
		return a === b;
	}
	return Math.abs(a - b) < 30 * 60_000;
}

/** Valid alert thresholds from the setting: percentages in (0, 100], ascending, no repeats. */
export function toThresholds(value: unknown): number[] {
	if (!Array.isArray(value)) {
		return [];
	}
	return [...new Set(value.filter((v): v is number => typeof v === 'number' && v > 0 && v <= 100))].sort((a, b) => a - b);
}

// ---- Formatting -------------------------------------------------------------------

/** "Resets in 51 min", "Resets in 3 h 5 min", or a weekday and time when it is further off. */
export function formatResets(resetsAt: number, now: number, locale?: string): string {
	const ms = resetsAt - now;
	if (ms <= 0) {
		return localize('usageLimits.reset', "Reset");
	}
	const minutes = Math.ceil(ms / 60_000);
	if (minutes < 60) {
		return localize('usageLimits.resetsMinutes', "Resets in {0} min", minutes);
	}
	if (minutes < 6 * 60) {
		const h = Math.floor(minutes / 60);
		const m = minutes % 60;
		return m
			? localize('usageLimits.resetsHoursMinutes', "Resets in {0} h {1} min", h, m)
			: localize('usageLimits.resetsHours', "Resets in {0} h", h);
	}
	const when = new Intl.DateTimeFormat(locale, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(resetsAt);
	return localize('usageLimits.resetsAt', "Resets {0}", when);
}

/** "73%", or "—" when the window is known but its fill is not. */
export function formatPercent(percent: number | undefined): string {
	return percent === undefined ? '—' : `${Math.round(percent)}%`;
}

function clampPercent(value: number): number {
	return Math.min(100, Math.max(0, value));
}

function asObject(value: unknown): Json | undefined {
	return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Json : undefined;
}
