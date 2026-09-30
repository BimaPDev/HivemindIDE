/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE provider failover: the user's backup providers and the choice
 *  of which one takes over.
 *
 *  The user decides how this behaves (`hivemindide.failover.mode`): ask each
 *  time, switch automatically, or never switch. Providers are theirs too, in
 *  their order; keys stay in secret storage. The chat agent calls
 *  `chooseNext` when a provider fails and continues the answer on whatever
 *  comes back.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ILocalLlamaRemote } from '../../../../../platform/hivemindide/common/localLlama.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { HivemindIDESettings } from '../../common/hivemindideConfiguration.js';
import { availableFallbacks, describeFailure, FailoverMode, formatWait, IFailoverProvider, IProviderCooldown, IProviderFailure, parseFailoverProviders, ProviderCooldowns, toFailoverMode } from '../../common/providerFailover.js';

export const IProviderFailoverService = createDecorator<IProviderFailoverService>('hivemindideProviderFailoverService');

export interface IProviderFailoverService {
	readonly _serviceBrand: undefined;

	/** Settings, keys or cooldowns changed. */
	readonly onDidChange: Event<void>;

	readonly mode: FailoverMode;
	/** The services in use: every configured one that is not turned off, in the user's order. */
	readonly providers: readonly IFailoverProvider[];
	/** Every configured service, including the ones turned off. */
	readonly allProviders: readonly IFailoverProvider[];
	/** Replaces the list: edits, reordering, turning services on and off. Keys are untouched. */
	saveProviders(providers: readonly IFailoverProvider[]): Promise<void>;

	setMode(mode: FailoverMode): Promise<void>;
	addProvider(provider: IFailoverProvider, apiKey: string | undefined): Promise<void>;
	removeProvider(name: string): Promise<void>;
	setApiKey(name: string, apiKey: string | undefined): Promise<void>;
	/** Where to send a request for `provider`, key included. */
	remoteFor(provider: IFailoverProvider): Promise<ILocalLlamaRemote>;

	/** Set while `provider` (a backup, or the chat's own model by name) is being skipped. */
	cooldown(provider: string): IProviderCooldown | undefined;
	activeCooldowns(): [string, IProviderCooldown][];
	markFailed(provider: string, failure: IProviderFailure): void;
	/** Tries every provider again, and forgets choices made while one was out. */
	clearCooldowns(): void;

	/**
	 * The backup to continue on after `failed` failed, or undefined to stop.
	 * In `ask` mode this asks, unless the user already chose a backup for this
	 * provider and it is still out. `tried` are providers this answer already
	 * failed on.
	 */
	chooseNext(failed: string, failure: IProviderFailure, tried: ReadonlySet<string>, token: CancellationToken, extra?: readonly IFailoverProvider[]): Promise<IFailoverProvider | undefined>;
}

const API_KEY_SECRET_PREFIX = 'hivemindide.failover.apiKey.';

interface IChoice extends IQuickPickItem {
	readonly provider?: IFailoverProvider;
	readonly always?: boolean;
}

export class ProviderFailoverService extends Disposable implements IProviderFailoverService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly cooldowns = new ProviderCooldowns();
	/** Backup the user picked for a provider that is out, kept until it is back. */
	private readonly chosen = new Map<string, { readonly fallback: string; readonly until: number }>();

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(HivemindIDESettings.FailoverMode) || e.affectsConfiguration(HivemindIDESettings.FailoverProviders)) {
				this._onDidChange.fire();
			}
		}));
	}

	get mode(): FailoverMode {
		return toFailoverMode(this.configurationService.getValue(HivemindIDESettings.FailoverMode));
	}

	get providers(): readonly IFailoverProvider[] {
		return this.allProviders.filter(p => p.enabled !== false);
	}

	get allProviders(): readonly IFailoverProvider[] {
		return parseFailoverProviders(this.configurationService.getValue(HivemindIDESettings.FailoverProviders));
	}

	async saveProviders(providers: readonly IFailoverProvider[]): Promise<void> {
		await this.configurationService.updateValue(HivemindIDESettings.FailoverProviders, providers, ConfigurationTarget.USER);
	}

	async setMode(mode: FailoverMode): Promise<void> {
		await this.configurationService.updateValue(HivemindIDESettings.FailoverMode, mode, ConfigurationTarget.USER);
	}

	async addProvider(provider: IFailoverProvider, apiKey: string | undefined): Promise<void> {
		const others = this.allProviders.filter(p => p.name !== provider.name);
		await this.setApiKey(provider.name, apiKey);
		await this.configurationService.updateValue(HivemindIDESettings.FailoverProviders, [...others, provider], ConfigurationTarget.USER);
	}

	async removeProvider(name: string): Promise<void> {
		await this.configurationService.updateValue(HivemindIDESettings.FailoverProviders, this.allProviders.filter(p => p.name !== name), ConfigurationTarget.USER);
		await this.setApiKey(name, undefined);
	}

	async setApiKey(name: string, apiKey: string | undefined): Promise<void> {
		if (apiKey) {
			await this.secretStorageService.set(API_KEY_SECRET_PREFIX + name, apiKey);
		} else {
			await this.secretStorageService.delete(API_KEY_SECRET_PREFIX + name);
		}
		// A new key is the usual fix for whatever put the provider on hold.
		this.cooldowns.clear(name);
		this._onDidChange.fire();
	}

	async remoteFor(provider: IFailoverProvider): Promise<ILocalLlamaRemote> {
		return {
			url: provider.url,
			model: provider.model,
			apiKey: await this.secretStorageService.get(API_KEY_SECRET_PREFIX + provider.name),
			standardOnly: true,
		};
	}

	cooldown(provider: string): IProviderCooldown | undefined {
		return this.cooldowns.get(provider);
	}

	activeCooldowns(): [string, IProviderCooldown][] {
		return this.cooldowns.active();
	}

	markFailed(provider: string, failure: IProviderFailure): void {
		if (this.cooldowns.mark(provider, failure)) {
			this._onDidChange.fire();
		}
	}

	clearCooldowns(): void {
		this.cooldowns.clear();
		this.chosen.clear();
		this._onDidChange.fire();
	}

	async chooseNext(failed: string, failure: IProviderFailure, tried: ReadonlySet<string>, token: CancellationToken, extra: readonly IFailoverProvider[] = []): Promise<IFailoverProvider | undefined> {
		const mode = this.mode;
		if (mode === 'off') {
			return undefined;
		}
		// `extra`: backups that are not configured providers, such as installed agent CLIs.
		const candidates = availableFallbacks([...this.providers, ...extra.filter(e => !this.providers.some(p => p.name === e.name))], new Set([...tried, failed]), this.cooldowns);
		if (candidates.length === 0) {
			return undefined;
		}
		if (mode === 'auto') {
			return candidates[0];
		}

		const earlier = this.chosen.get(failed);
		if (earlier && earlier.until > Date.now()) {
			const provider = candidates.find(p => p.name === earlier.fallback);
			if (provider) {
				return provider;
			}
		}

		const cooldown = this.cooldowns.get(failed);
		const title = cooldown
			? localize('failover.ask.titleUntil', "{0} {1} (available again {2}). Continue this answer on:", failed, describeFailure(failure), formatWait(cooldown.until - Date.now()))
			: localize('failover.ask.title', "{0} {1}. Continue this answer on:", failed, describeFailure(failure));
		const items: (IChoice | IQuickPickSeparator)[] = [
			...candidates.map((provider): IChoice => ({
				label: `$(arrow-right) ${provider.name}`,
				description: provider.model,
				provider,
			})),
			{ type: 'separator' },
			{
				label: localize('failover.ask.always', "Always Switch Automatically"),
				detail: localize('failover.ask.alwaysDetail', "Continue on {0} now, and switch without asking from now on. Change this in Settings under HivemindIDE: Failover Mode.", candidates[0].name),
				provider: candidates[0],
				always: true,
			},
			{ label: localize('failover.ask.stop', "Stop Here"), detail: localize('failover.ask.stopDetail', "Keep the answer so far. Reply \"continue\" later to resume it.") },
		];
		const pick = await this.quickInputService.pick(items, { title, placeHolder: localize('failover.ask.placeholder', "Choose a provider, or stop"), ignoreFocusLost: true }, token);
		if (!pick?.provider || token.isCancellationRequested) {
			return undefined;
		}
		if (pick.always) {
			await this.setMode('auto');
		} else if (cooldown) {
			this.chosen.set(failed, { fallback: pick.provider.name, until: cooldown.until });
		}
		return pick.provider;
	}
}
