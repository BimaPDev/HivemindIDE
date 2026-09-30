/*---------------------------------------------------------------------------------------------
 *  Reads Claude Code's local stats cache.
 *
 *  This is the same trick codenotch uses: the installed tool already keeps usage
 *  data on disk, so we read it rather than asking the user for another API key.
 *  It is strictly read-only, and it never leaves the machine.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IProviderUsage, IUsageSnapshot } from '../common/usage.js';

/** The subset of ~/.claude/stats-cache.json we depend on. */
interface IClaudeStatsCache {
	readonly lastComputedDate?: string;
	readonly dailyActivity?: ReadonlyArray<{
		date: string;
		messageCount?: number;
		sessionCount?: number;
		toolCallCount?: number;
	}>;
	readonly dailyModelTokens?: ReadonlyArray<{
		date: string;
		tokensByModel?: Record<string, number>;
	}>;
	readonly modelUsage?: Record<string, { costUSD?: number }>;
}

export class ClaudeUsageReader {

	constructor(
		private readonly fileService: IFileService,
		private readonly pathService: IPathService,
	) { }

	async read(): Promise<IUsageSnapshot> {
		const home = this.pathService.userHome({ preferLocal: true });
		const statsFile = URI.joinPath(home, '.claude', 'stats-cache.json');

		let raw: string;
		try {
			const content = await this.fileService.readFile(statsFile);
			raw = content.value.toString();
		} catch (err) {
			// Not installed, or no stats yet. Not an error worth logging on a timer.
			return { providers: [], unavailableReason: 'Claude Code usage data not found on this machine.' };
		}

		let cache: IClaudeStatsCache;
		try {
			cache = JSON.parse(raw) as IClaudeStatsCache;
		} catch (err) {
			return { providers: [], unavailableReason: 'Claude Code usage data could not be parsed.' };
		}

		const usage = this.toUsage(cache);
		if (!usage) {
			return { providers: [], unavailableReason: 'Claude Code has recorded no daily usage yet.' };
		}
		return { providers: [usage] };
	}

	private toUsage(cache: IClaudeStatsCache): IProviderUsage | undefined {
		const daily = cache.dailyModelTokens ?? [];
		if (daily.length === 0) {
			return undefined;
		}

		// Prefer today; fall back to the most recent day the cache knows about and
		// mark it stale, so the tooltip can say which day it is actually showing.
		const today = toISODate(new Date());
		const latest = daily.reduce((a, b) => (a.date > b.date ? a : b));
		const chosen = daily.find(d => d.date === today) ?? latest;

		const byModel = Object.entries(chosen.tokensByModel ?? {})
			.map(([model, tokens]) => ({ model, tokens: tokens ?? 0 }))
			.sort((a, b) => b.tokens - a.tokens);

		const activity = (cache.dailyActivity ?? []).find(d => d.date === chosen.date);

		return {
			providerId: 'claude-code',
			providerLabel: 'Claude Code',
			tokens: byModel.reduce((sum, m) => sum + m.tokens, 0),
			date: chosen.date,
			stale: chosen.date !== today,
			byModel,
			// costUSD is per-model lifetime, not per-day, and is frequently 0 —
			// treat it as "may be absent" rather than a number we can rely on.
			costUSD: Object.values(cache.modelUsage ?? {}).reduce((sum, m) => sum + (m.costUSD ?? 0), 0),
			sessionCount: activity?.sessionCount ?? 0,
			messageCount: activity?.messageCount ?? 0,
		};
	}
}

function toISODate(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
