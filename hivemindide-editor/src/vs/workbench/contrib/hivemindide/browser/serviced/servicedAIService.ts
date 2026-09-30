/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE Serviced AI: combos, the default route, and per-route usage.
 *
 *  The services themselves (providers, keys, cooldowns) live in
 *  IProviderFailoverService; installed agent CLIs in IShellAgentService. This
 *  service adds what routing across them needs: the user's combos, which
 *  target each combo's turn starts on, and what every route has done so far.
 *  Usage is kept in application storage so the dashboard survives restarts.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { HivemindIDESettings } from '../../common/hivemindideConfiguration.js';
import { ICombo, IRouteStats, orderComboTargets, parseCombos, recordOutcome } from '../../common/servicedRouting.js';
import { ITraitOverrides, parseTraitOverrides, TaskKind } from '../../common/modelCatalog.js';

export const IServicedAIService = createDecorator<IServicedAIService>('hivemindideServicedAIService');

export interface IServicedAIService {
	readonly _serviceBrand: undefined;

	/** Combos, the default route or usage changed. */
	readonly onDidChange: Event<void>;

	readonly combos: readonly ICombo[];
	saveCombos(combos: readonly ICombo[]): Promise<void>;

	/** The route id new chats start on, when the user chose one. */
	readonly defaultRoute: string | undefined;
	setDefaultRoute(id: string | undefined): Promise<void>;

	stats(route: string): IRouteStats | undefined;
	readonly allStats: ReadonlyMap<string, IRouteStats>;
	/** One request on `route` finished. */
	record(route: string, ok: boolean, ms: number, error?: string): void;
	resetStats(): void;

	/** The order a turn on combo `name` tries its targets in. Advances round-robin. */
	planCombo(name: string, available: (route: string) => boolean): string[];
	/** A turn on combo `name` succeeded on `route`, for last-good. */
	comboSucceeded(name: string, route: string): void;

	/** Routes seen to fail because their model cannot call tools. Remembered across restarts. */
	isToolless(route: string): boolean;
	markToolless(route: string): void;

	/** The user's corrections to a model's traits, by route. */
	readonly traitOverrides: Readonly<Record<string, ITraitOverrides>>;
	setTraitOverrides(route: string, overrides: ITraitOverrides | undefined): Promise<void>;

	/** The route pinned for a task, or undefined for automatic. */
	taskRoute(task: TaskKind): string | undefined;
	setTaskRoute(task: TaskKind, route: string | undefined): Promise<void>;
}

const STATS_KEY = 'hivemindide.serviced.stats';
const LAST_GOOD_KEY = 'hivemindide.serviced.lastGood';
const TOOLLESS_KEY = 'hivemindide.serviced.toolless';

export class ServicedAIService extends Disposable implements IServicedAIService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _stats: Map<string, IRouteStats>;
	private readonly lastGood: Map<string, string>;
	private readonly turns = new Map<string, number>();
	private readonly toolless: Set<string>;
	private readonly save = this._register(new RunOnceScheduler(() => this.persist(), 2000));

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this._stats = new Map(Object.entries(this.storageService.getObject<Record<string, IRouteStats>>(STATS_KEY, StorageScope.APPLICATION, {})));
		this.lastGood = new Map(Object.entries(this.storageService.getObject<Record<string, string>>(LAST_GOOD_KEY, StorageScope.APPLICATION, {})));
		this.toolless = new Set(this.storageService.getObject<string[]>(TOOLLESS_KEY, StorageScope.APPLICATION, []));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(HivemindIDESettings.ServicedCombos) || e.affectsConfiguration(HivemindIDESettings.ServicedDefaultRoute) || e.affectsConfiguration(HivemindIDESettings.ModelTraits) || e.affectsConfiguration(HivemindIDESettings.ModelTaskRoutes)) {
				this._onDidChange.fire();
			}
		}));
		this._register(this.storageService.onWillSaveState(() => this.persist()));
	}

	get combos(): readonly ICombo[] {
		return parseCombos(this.configurationService.getValue(HivemindIDESettings.ServicedCombos));
	}

	async saveCombos(combos: readonly ICombo[]): Promise<void> {
		await this.configurationService.updateValue(HivemindIDESettings.ServicedCombos, combos, ConfigurationTarget.USER);
	}

	get defaultRoute(): string | undefined {
		return this.configurationService.getValue<string>(HivemindIDESettings.ServicedDefaultRoute)?.trim() || undefined;
	}

	async setDefaultRoute(id: string | undefined): Promise<void> {
		await this.configurationService.updateValue(HivemindIDESettings.ServicedDefaultRoute, id ?? '', ConfigurationTarget.USER);
	}

	stats(route: string): IRouteStats | undefined {
		return this._stats.get(route);
	}

	get allStats(): ReadonlyMap<string, IRouteStats> {
		return this._stats;
	}

	record(route: string, ok: boolean, ms: number, error?: string): void {
		this._stats.set(route, recordOutcome(this._stats.get(route), ok, ms, Date.now(), error));
		this.save.schedule();
		this._onDidChange.fire();
	}

	resetStats(): void {
		this._stats.clear();
		this.persist();
		this._onDidChange.fire();
	}

	planCombo(name: string, available: (route: string) => boolean): string[] {
		const combo = this.combos.find(c => c.name === name);
		if (!combo) {
			return [];
		}
		const turn = this.turns.get(name) ?? 0;
		this.turns.set(name, turn + 1);
		return orderComboTargets(combo, { stats: route => this._stats.get(route), available, turn, lastGood: this.lastGood.get(name), random: Math.random });
	}

	comboSucceeded(name: string, route: string): void {
		this.lastGood.set(name, route);
		this.save.schedule();
	}

	isToolless(route: string): boolean {
		return this.toolless.has(route);
	}

	markToolless(route: string): void {
		if (!this.toolless.has(route)) {
			this.toolless.add(route);
			this.persist();
			this._onDidChange.fire();
		}
	}

	get traitOverrides(): Readonly<Record<string, ITraitOverrides>> {
		return parseTraitOverrides(this.configurationService.getValue(HivemindIDESettings.ModelTraits));
	}

	async setTraitOverrides(route: string, overrides: ITraitOverrides | undefined): Promise<void> {
		const all: Record<string, ITraitOverrides> = { ...this.traitOverrides };
		if (overrides && Object.keys(overrides).length) {
			all[route] = overrides;
		} else {
			delete all[route];
		}
		await this.configurationService.updateValue(HivemindIDESettings.ModelTraits, all, ConfigurationTarget.USER);
	}

	taskRoute(task: TaskKind): string | undefined {
		const value = this.configurationService.getValue<Record<string, string>>(HivemindIDESettings.ModelTaskRoutes)?.[task]?.trim();
		return value && value !== 'auto' ? value : undefined;
	}

	async setTaskRoute(task: TaskKind, route: string | undefined): Promise<void> {
		const all = { ...this.configurationService.getValue<Record<string, string>>(HivemindIDESettings.ModelTaskRoutes) };
		if (route) {
			all[task] = route;
		} else {
			delete all[task];
		}
		await this.configurationService.updateValue(HivemindIDESettings.ModelTaskRoutes, all, ConfigurationTarget.USER);
	}

	private persist(): void {
		this.storageService.store(TOOLLESS_KEY, JSON.stringify([...this.toolless]), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.storageService.store(STATS_KEY, JSON.stringify(Object.fromEntries(this._stats)), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.storageService.store(LAST_GOOD_KEY, JSON.stringify(Object.fromEntries(this.lastGood)), StorageScope.APPLICATION, StorageTarget.MACHINE);
	}
}
