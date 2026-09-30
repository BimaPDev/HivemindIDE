/*---------------------------------------------------------------------------------------------
 *  Status bar indicator for AI assistant usage.
 *
 *  The pattern every HivemindIDE feature follows:
 *    - gated on a `hivemindide.<feature>.enabled` setting
 *    - reacts to that setting changing, with no reload
 *    - when disabled, holds no resources at all: the entry is removed and the
 *      polling timer is cancelled, so "off" means off, not hidden
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../../base/common/async.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IPathService } from '../../../services/path/common/pathService.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { HivemindIDESettings, HIVEMINDIDE_CONFIG_SECTION } from '../common/hivemindideConfiguration.js';
import { formatTokens, IUsageSnapshot, totalTokens } from '../common/usage.js';
import { ClaudeUsageReader } from './claudeUsageService.js';

const ENTRY_ID = 'hivemindide.usageIndicator';

export class UsageIndicatorContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.hivemindide.usageIndicator';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());
	private readonly timer = this._register(new IntervalTimer());
	private readonly reader: ClaudeUsageReader;

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService fileService: IFileService,
		@IPathService pathService: IPathService,
	) {
		super();

		this.reader = new ClaudeUsageReader(fileService, pathService);

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(HIVEMINDIDE_CONFIG_SECTION)) {
				this.update();
			}
		}));

		this.update();
	}

	/** Brings the feature in line with its settings, in either direction. */
	private update(): void {
		if (!this.configurationService.getValue<boolean>(HivemindIDESettings.UsageIndicatorEnabled)) {
			this.disable();
			return;
		}

		const seconds = this.configurationService.getValue<number>(HivemindIDESettings.UsageIndicatorRefreshSeconds) ?? 60;
		// cancelAndSet rather than "start if not started": the interval may have
		// changed, and this path also runs on every settings edit.
		this.timer.cancelAndSet(() => this.refresh(), Math.max(10, seconds) * 1000);
		this.refresh();
	}

	private disable(): void {
		this.timer.cancel();
		this.entry.clear();
	}

	private async refresh(): Promise<void> {
		const snapshot = await this.reader.read();

		// The setting may have been turned off while the read was in flight.
		if (!this.configurationService.getValue<boolean>(HivemindIDESettings.UsageIndicatorEnabled)) {
			this.disable();
			return;
		}

		const entry = this.render(snapshot);
		if (this.entry.value) {
			this.entry.value.update(entry);
		} else {
			this.entry.value = this.statusbarService.addEntry(entry, ENTRY_ID, StatusbarAlignment.RIGHT, 100);
		}
	}

	private render(snapshot: IUsageSnapshot): IStatusbarEntry {
		const name = localize('hivemindide.usage.name', "AI Usage");

		if (snapshot.providers.length === 0) {
			return {
				name,
				text: `$(pulse) ${localize('hivemindide.usage.none', "no data")}`,
				ariaLabel: snapshot.unavailableReason ?? localize('hivemindide.usage.none', "no data"),
				tooltip: snapshot.unavailableReason,
				command: 'hivemindide.action.openSettings'
			};
		}

		const tokens = totalTokens(snapshot);
		const budget = this.configurationService.getValue<number>(HivemindIDESettings.UsageIndicatorDailyTokenBudget) ?? 0;
		const anyStale = snapshot.providers.some(p => p.stale);

		const label = budget > 0
			? `${Math.round((tokens / budget) * 100)}%`
			: formatTokens(tokens);

		return {
			name,
			// A trailing "~" is the whole stale signal in the narrow entry; the
			// tooltip carries the detail. Showing a stale number bare would be
			// the one genuinely misleading thing this feature could do.
			text: `$(pulse) ${label}${anyStale ? ' ~' : ''}`,
			ariaLabel: localize('hivemindide.usage.aria', "AI usage: {0} tokens", tokens),
			tooltip: this.renderTooltip(snapshot, budget),
			command: 'hivemindide.action.openSettings'
		};
	}

	private renderTooltip(snapshot: IUsageSnapshot, budget: number): MarkdownString {
		const md = new MarkdownString('', { isTrusted: true, supportThemeIcons: true });
		const showCost = this.configurationService.getValue<boolean>(HivemindIDESettings.UsageIndicatorShowCost);

		for (const p of snapshot.providers) {
			md.appendMarkdown(`**${p.providerLabel}** — ${p.date}\n\n`);

			if (p.stale) {
				md.appendMarkdown(`_${localize('hivemindide.usage.stale', "No usage recorded today. Showing the most recent day with data.")}_\n\n`);
			}

			md.appendMarkdown(`${localize('hivemindide.usage.tokens', "Tokens")}: ${p.tokens.toLocaleString()}`);
			if (budget > 0) {
				md.appendMarkdown(` / ${budget.toLocaleString()}`);
			}
			md.appendMarkdown('\n\n');

			if (p.sessionCount || p.messageCount) {
				md.appendMarkdown(`${localize('hivemindide.usage.sessions', "Sessions")}: ${p.sessionCount} · ${localize('hivemindide.usage.messages', "Messages")}: ${p.messageCount}\n\n`);
			}

			for (const m of p.byModel) {
				md.appendMarkdown(`- \`${m.model}\` — ${m.tokens.toLocaleString()}\n`);
			}

			if (showCost && p.costUSD > 0) {
				md.appendMarkdown(`\n${localize('hivemindide.usage.cost', "Reported cost")}: $${p.costUSD.toFixed(2)}\n`);
			}
			md.appendMarkdown('\n');
		}

		md.appendMarkdown(`---\n\n_${localize('hivemindide.usage.source', "Read from local tool data. Nothing leaves this machine. Disable in Settings: {0}", HivemindIDESettings.UsageIndicatorEnabled)}_`);
		return md;
	}
}
