/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Feeds this window's usage rings to the MacBook notch (see
 *  platform/hivemindide/common/hivemindNotch.ts) and hides the in-window
 *  notch while the hardware one shows, so the rings are never in two places.
 *
 *  The main process decides whether the Mac has a notch; this window only says
 *  whether it wants one. Disposing says it no longer does.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { language } from '../../../../../base/common/platform.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IHivemindNotchService, INotchRing } from '../../../../../platform/hivemindide/common/hivemindNotch.js';
import { HivemindIDESettings } from '../../common/hivemindideConfiguration.js';
import { effectivePercent, formatResets, headlineWindow, IProviderLimits, liveWindows, severityOf } from '../../common/usageLimits.js';
import { UsageLimitsModel } from './usageLimitsModel.js';
import { UsageNotchWidget } from './usageNotchWidget.js';

export class MacbookNotchBridge extends Disposable {

	/** Rings change in bursts (a Claude run reports several windows); send once they settle. */
	private readonly send = this._register(new RunOnceScheduler(() => this.update(), 150));

	constructor(
		private readonly model: UsageLimitsModel,
		private readonly widget: UsageNotchWidget,
		@IHivemindNotchService private readonly notchService: IHivemindNotchService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this._register(this.notchService.onDidChangeActive(active => this.widget.setSuppressed(active)));
		this._register(this.model.onDidChange(() => this.send.schedule()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(HivemindIDESettings.UsageNotchUseMacbookNotch)) {
				this.update();
			}
		}));
		this.update();
		this.notchService.isActive().then(active => {
			if (!this._store.isDisposed) {
				this.widget.setSuppressed(active);
			}
		});
	}

	private get enabled(): boolean {
		return this.configurationService.getValue<boolean>(HivemindIDESettings.UsageNotchUseMacbookNotch) !== false;
	}

	private update(): void {
		const now = Date.now();
		this.notchService.update(mainWindow.vscodeWindowId, { enabled: this.enabled, rings: this.enabled ? this.model.providers.map(p => toRing(p, now)) : [] });
	}

	override dispose(): void {
		// Turning the usage notch off takes the hardware one with it.
		this.notchService.update(mainWindow.vscodeWindowId, { enabled: false, rings: [] });
		super.dispose();
	}
}

function toRing(provider: IProviderLimits, now: number): INotchRing {
	const window = headlineWindow(provider, now);
	const percent = window && effectivePercent(window);
	const detail = !window
		? provider.observedAt === undefined
			? localize('macbookNotch.noReading', "No reading yet")
			: localize('macbookNotch.reset', "Awaiting a new reading")
		: window.resetsAt !== undefined
			? localize('macbookNotch.detail', "{0} · {1}", window.label, formatResets(window.resetsAt, now, language))
			: window.label;
	const windows = liveWindows(provider, now).map(w => {
		const p = effectivePercent(w);
		return { label: w.label, percent: p, severity: severityOf(p), reset: w.resetsAt !== undefined ? formatResets(w.resetsAt, now, language) : undefined, exhausted: w.exhausted };
	});
	return { id: provider.id, label: provider.label, glyph: provider.glyph, percent, severity: severityOf(percent), detail, windows };
}
