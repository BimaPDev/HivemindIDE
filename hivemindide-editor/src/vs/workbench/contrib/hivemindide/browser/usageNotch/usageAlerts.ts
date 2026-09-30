/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Usage alerts: a notification when a plan limit crosses one of the user's
 *  thresholds (80% and 100% by default), once per threshold per limit window.
 *
 *  What was already alerted lives in application storage, so a restart does not
 *  repeat it. Every window sees the same readings (Claude Code's limit events
 *  reach all of them at once), so a window claims an alert in storage, waits
 *  for other windows' claims to arrive, and only the window whose claim
 *  survived shows it.
 *--------------------------------------------------------------------------------------------*/

import { toAction } from '../../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { language } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { HivemindIDESettings } from '../../common/hivemindideConfiguration.js';
import { formatPercent, formatResets, IAlertMark, IProviderLimits, IUsageWindow, liveWindows, nextAlert, toThresholds } from '../../common/usageLimits.js';
import { UsageLimitsModel } from './usageLimitsModel.js';

const MARKS_STORAGE_KEY = 'hivemindide.usageNotch.alertMarks';
/** Long enough for another window's storage write to arrive over IPC. */
const CLAIM_SETTLE_MS = 1500;
/** Marks for windows that reset longer ago than this are forgotten. */
const MARK_RETENTION_MS = 24 * 60 * 60_000;

interface IStoredMark extends IAlertMark {
	/** The workbench window that will show this alert; set only while an alert is pending. */
	readonly claim?: string;
}

interface IPendingAlert {
	readonly key: string;
	readonly provider: IProviderLimits;
	readonly limit: IUsageWindow;
	readonly threshold: number;
}

export class UsageAlerts extends Disposable {

	private readonly id = generateUuid();
	private pending: IPendingAlert[] = [];
	private readonly settle = this._register(new RunOnceScheduler(() => this.showClaimed(), CLAIM_SETTLE_MS));

	constructor(
		private readonly model: UsageLimitsModel,
		@INotificationService private readonly notificationService: INotificationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this._register(this.model.onDidChange(() => this.check()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(HivemindIDESettings.UsageNotchAlertThresholds)) {
				this.check();
			}
		}));
		this.check();
	}

	private check(): void {
		const thresholds = toThresholds(this.configurationService.getValue(HivemindIDESettings.UsageNotchAlertThresholds));
		const now = Date.now();
		const marks = this.loadMarks();
		const seen = new Set<string>();

		for (const provider of this.model.providers) {
			for (const limit of liveWindows(provider, now)) {
				const key = `${provider.id}/${limit.id}`;
				seen.add(key);
				const { alert, mark } = nextAlert(marks[key], limit, thresholds);
				if (!mark) {
					delete marks[key];
				} else if (alert !== undefined) {
					marks[key] = { ...mark, claim: this.id };
					this.pending = [...this.pending.filter(p => p.key !== key), { key, provider, limit, threshold: alert }];
				} else {
					marks[key] = { ...mark, claim: marks[key]?.claim };
				}
			}
		}

		for (const [key, mark] of Object.entries(marks)) {
			if (!seen.has(key) && mark.resetsAt !== undefined && mark.resetsAt < now - MARK_RETENTION_MS) {
				delete marks[key];
			}
		}
		this.storeMarks(marks);

		if (this.pending.length && !this.settle.isScheduled()) {
			this.settle.schedule();
		}
	}

	private showClaimed(): void {
		const marks = this.loadMarks();
		const muted = new Set((this.configurationService.getValue<string[]>(HivemindIDESettings.UsageNotchMutedProviders) ?? []).map(name => name.toLowerCase()));
		const pending = this.pending;
		this.pending = [];

		for (const alert of pending) {
			if (marks[alert.key]?.claim !== this.id) {
				continue; // another workbench window claimed it later and shows it
			}
			marks[alert.key] = { resetsAt: marks[alert.key].resetsAt, level: marks[alert.key].level };
			if (!muted.has(alert.provider.label.toLowerCase())) {
				this.notify(alert);
			}
		}
		this.storeMarks(marks);
	}

	private notify({ provider, limit, threshold }: IPendingAlert): void {
		const reset = limit.resetsAt !== undefined ? formatResets(limit.resetsAt, Date.now(), language) : undefined;
		const reached = limit.exhausted || threshold >= 100;
		const message = reached
			? reset
				? localize('usageNotch.alert.reachedReset', "{0} · {1}: limit reached. {2}.", provider.label, limit.label, reset)
				: localize('usageNotch.alert.reached', "{0} · {1}: limit reached.", provider.label, limit.label)
			: reset
				? localize('usageNotch.alert.usedReset', "{0} · {1}: {2} used. {3}.", provider.label, limit.label, formatPercent(limit.usedPercent), reset)
				: localize('usageNotch.alert.used', "{0} · {1}: {2} used.", provider.label, limit.label, formatPercent(limit.usedPercent));

		this.notificationService.notify({
			severity: reached ? Severity.Warning : Severity.Info,
			message,
			source: localize('usageNotch.alert.source', "HivemindIDE Usage"),
			actions: {
				primary: [toAction({
					id: 'hivemindide.usageNotch.mute',
					label: localize('usageNotch.alert.mute', "Mute {0} Alerts", provider.label),
					run: () => {
						const muted = this.configurationService.getValue<string[]>(HivemindIDESettings.UsageNotchMutedProviders) ?? [];
						return this.configurationService.updateValue(HivemindIDESettings.UsageNotchMutedProviders, [...new Set([...muted, provider.label])], ConfigurationTarget.USER);
					},
				})],
			},
		});
	}

	private loadMarks(): Record<string, IStoredMark> {
		try {
			const parsed = JSON.parse(this.storageService.get(MARKS_STORAGE_KEY, StorageScope.APPLICATION, '{}'));
			return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
		} catch {
			return {};
		}
	}

	private storeMarks(marks: Record<string, IStoredMark>): void {
		this.storageService.store(MARKS_STORAGE_KEY, JSON.stringify(marks), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}
}
