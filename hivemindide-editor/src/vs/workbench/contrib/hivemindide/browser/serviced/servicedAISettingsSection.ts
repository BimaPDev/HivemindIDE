/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE Serviced AI: the settings section.
 *
 *  Everything that reaches an AI over the network, in one place: the API
 *  services (add, test, key, models, on/off, order), the agent CLIs found on
 *  this machine, combos (chains of routes with a strategy), where new chats
 *  start and what happens when a route runs out, and how every route has been
 *  doing. A view over IProviderFailoverService, IShellAgentService and
 *  IServicedAIService; keys only ever go to secret storage.
 *
 *  Like the Local Models section, it re-renders on change but never while an
 *  input inside it has focus.
 *--------------------------------------------------------------------------------------------*/

import '../localModels/media/localModelsSettings.css';
import './media/servicedAI.css';
import { $, addDisposableListener, append, clearNode, getActiveElement, getWindow, isHTMLElement } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { ISelectOptionItem, SelectBox } from '../../../../../base/browser/ui/selectBox/selectBox.js';
import { Checkbox } from '../../../../../base/browser/ui/toggle/toggle.js';
import { fromNow } from '../../../../../base/common/date.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ILocalLlamaService } from '../../../../../platform/hivemindide/common/localLlama.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { HivemindIDESettings } from '../../common/hivemindideConfiguration.js';
import { describeFailure, IFailoverProvider } from '../../common/providerFailover.js';
import { averageMs, COMBO_PROVIDER, COMBO_STRATEGIES, ComboStrategy, ICombo, IRouteStats } from '../../common/servicedRouting.js';
import { IHivemindIDESettingsSection } from '../hivemindideSettingsSections.js';
import { IProviderFailoverService } from '../localModels/providerFailoverService.js';
import { IShellAgentService } from '../shell/shellAgentService.js';
import { IServicedAIService } from './servicedAIService.js';
import { AUTO_PROVIDER, CostLevel, ICatalogEntry, ITraitOverrides, Level, TASKS, TaskKind } from '../../common/modelCatalog.js';

const ADD_PROVIDER_COMMAND_ID = 'hivemindide.failover.addProvider';
const RESCAN_CLIS_COMMAND_ID = 'hivemindide.shell.rescanClis';

const STRATEGY_LABELS: Record<ComboStrategy, string> = {
	'priority': localize('serviced.strategy.priority', "Priority: first target, next when it fails"),
	'round-robin': localize('serviced.strategy.roundRobin', "Round-robin: each turn starts on the next target"),
	'weighted': localize('serviced.strategy.weighted', "Weighted: targets share turns by weight"),
	'random': localize('serviced.strategy.random', "Random: any target, evenly"),
	'least-used': localize('serviced.strategy.leastUsed', "Least used: the target with the fewest requests"),
	'last-good': localize('serviced.strategy.lastGood', "Last good: where the last turn succeeded"),
	'fastest': localize('serviced.strategy.fastest', "Fastest: the lowest average response time"),
};

export class ServicedAISettingsSection extends Disposable implements IHivemindIDESettingsSection {

	private root: HTMLElement | undefined;
	private readonly content = this._register(new MutableDisposable<DisposableStore>());
	private pendingRender = false;
	/** Which services have a key saved, loaded from secret storage. */
	private keys = new Map<string, boolean>();

	constructor(
		@IProviderFailoverService private readonly failoverService: IProviderFailoverService,
		@IServicedAIService private readonly servicedAIService: IServicedAIService,
		@IShellAgentService private readonly shellAgentService: IShellAgentService,
		@ILocalLlamaService private readonly localLlamaService: ILocalLlamaService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super();
	}

	render(parent: HTMLElement): void {
		this.root = append(parent, $('.hivemindide-lm.hivemindide-sai'));
		this._register(this.failoverService.onDidChange(() => this.loadKeys()));
		this._register(this.servicedAIService.onDidChange(() => this.scheduleRender()));
		this._register(this.shellAgentService.onDidChange(() => this.scheduleRender()));
		this._register(addDisposableListener(this.root, 'focusout', () => {
			setTimeout(() => {
				if (this.pendingRender && !this.isEditing()) {
					this.renderNow();
				}
			}, 0);
		}));
		// Resting states end on their own; keep the countdowns honest.
		const targetWindow = getWindow(this.root);
		const timer = targetWindow.setInterval(() => this.scheduleRender(), 30_000);
		this._register({ dispose: () => targetWindow.clearInterval(timer) });
		this.loadKeys();
		this.renderNow();
	}

	private async loadKeys(): Promise<void> {
		const keys = new Map<string, boolean>();
		for (const provider of this.failoverService.allProviders) {
			keys.set(provider.name, !!(await this.failoverService.remoteFor(provider)).apiKey);
		}
		this.keys = keys;
		this.scheduleRender();
	}

	private isEditing(): boolean {
		const active = getActiveElement();
		return !!this.root && isHTMLElement(active) && this.root.contains(active) && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT');
	}

	private scheduleRender(): void {
		if (this.isEditing()) {
			this.pendingRender = true;
		} else {
			this.renderNow();
		}
	}

	private renderNow(): void {
		if (!this.root) {
			return;
		}
		this.pendingRender = false;
		const store = new DisposableStore();
		this.content.value = store;
		clearNode(this.root);
		this.renderServices(this.root, store);
		this.renderClis(this.root, store);
		this.renderModels(this.root, store);
		this.renderTaskRouting(this.root, store);
		this.renderCombos(this.root, store);
		this.renderRouting(this.root, store);
		this.renderUsage(this.root, store);
	}

	// ---- Services ------------------------------------------------------------------

	private renderServices(parent: HTMLElement, store: DisposableStore): void {
		heading(parent, localize('serviced.services', "Services"));
		note(parent, localize('serviced.services.note', "API providers, in the order failover tries them. Each model is a route in the Chat model picker. For a second account on the same provider, add it again under another name."));
		const providers = this.failoverService.allProviders;
		if (providers.length === 0) {
			append(parent, $('p.hivemindide-lm-empty')).textContent = localize('serviced.services.empty', "No services yet.");
		}
		providers.forEach((provider, index) => this.renderService(parent, store, provider, index, providers));
		const buttons = append(parent, $('.hivemindide-lm-buttons'));
		this.button(buttons, store, localize('serviced.services.add', "Add Service…"), false, () => this.commandService.executeCommand(ADD_PROVIDER_COMMAND_ID));
		if (this.failoverService.activeCooldowns().length) {
			this.button(buttons, store, localize('serviced.services.retryAll', "Retry All Now"), true, () => this.failoverService.clearCooldowns());
		}
	}

	private renderService(parent: HTMLElement, store: DisposableStore, provider: IFailoverProvider, index: number, all: readonly IFailoverProvider[]): void {
		const enabled = provider.enabled !== false;
		const card = append(parent, $('.hivemindide-sai-card'));
		if (!enabled) {
			card.classList.add('off');
		}
		const head = append(card, $('.hivemindide-sai-card-head'));
		append(head, $('span.hivemindide-sai-name')).textContent = provider.name;
		this.health(head, provider.name, enabled);
		append(card, $('.hivemindide-lm-model-path')).textContent = provider.url;
		const models = [provider.model, ...(provider.models ?? [])];
		append(card, $('.hivemindide-sai-line')).textContent = localize('serviced.service.models', "Models: {0}", models.join(', '));
		const hasKey = this.keys.get(provider.name);
		append(card, $('.hivemindide-sai-line')).textContent = hasKey === undefined ? '' : hasKey ? localize('serviced.service.key', "Key saved in secure storage") : localize('serviced.service.noKey', "No key (fine for local servers)");
		this.statsLine(card, aggregate(this.servicedAIService.allStats, provider.name));

		const actions = append(card, $('.hivemindide-lm-model-actions'));
		this.link(actions, store, enabled ? localize('serviced.service.off', "Turn off") : localize('serviced.service.on', "Turn on"), () => this.saveProvider(index, { ...provider, enabled: enabled ? false : undefined }));
		if (index > 0) {
			this.link(actions, store, localize('serviced.service.up', "Move up"), () => this.move(index, -1));
		}
		if (index < all.length - 1) {
			this.link(actions, store, localize('serviced.service.down', "Move down"), () => this.move(index, 1));
		}
		this.link(actions, store, localize('serviced.service.editModels', "Models…"), () => this.editModels(index, provider));
		this.link(actions, store, localize('serviced.service.setKey', "Key…"), () => this.setKey(provider));
		this.link(actions, store, localize('serviced.service.test', "Test"), () => this.test(provider));
		this.link(actions, store, localize('serviced.service.remove', "Remove"), () => this.remove(provider));
	}

	/** "Ready", "Resting 12 min (rate limit)", or "Off". */
	private health(parent: HTMLElement, provider: string, enabled: boolean): void {
		const badge = append(parent, $('span.hivemindide-sai-health'));
		const cooldown = this.failoverService.cooldown(provider);
		if (!enabled) {
			badge.classList.add('off');
			badge.textContent = localize('serviced.health.off', "Off");
		} else if (cooldown) {
			badge.classList.add('resting');
			badge.textContent = localize('serviced.health.resting', "Resting until {0}: {1}", new Date(cooldown.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), describeFailure(cooldown.failure));
			badge.title = cooldown.failure.message;
		} else {
			badge.classList.add('ready');
			badge.textContent = localize('serviced.health.ready', "Ready");
		}
	}

	private statsLine(parent: HTMLElement, stats: IRouteStats | undefined): void {
		if (!stats?.requests) {
			append(parent, $('.hivemindide-sai-line.dim')).textContent = localize('serviced.stats.none', "Not used yet");
			return;
		}
		const avg = averageMs(stats);
		append(parent, $('.hivemindide-sai-line')).textContent = [
			stats.requests === 1 ? localize('serviced.stats.request', "1 request") : localize('serviced.stats.requests', "{0} requests", stats.requests),
			stats.failures ? localize('serviced.stats.failures', "{0} failed", stats.failures) : undefined,
			avg !== undefined ? localize('serviced.stats.avg', "avg {0}", formatMs(avg)) : undefined,
			stats.lastUsed ? localize('serviced.stats.last', "last {0}", fromNow(stats.lastUsed, true)) : undefined,
		].filter(Boolean).join(' · ');
		if (stats.lastError && stats.failures) {
			const error = append(parent, $('.hivemindide-sai-line.error'));
			error.textContent = localize('serviced.stats.lastError', "Last error: {0}", stats.lastError);
			error.title = stats.lastError;
		}
	}

	private async saveProvider(index: number, provider: IFailoverProvider): Promise<void> {
		const list = [...this.failoverService.allProviders];
		list[index] = provider;
		await this.failoverService.saveProviders(list);
	}

	private async move(index: number, delta: number): Promise<void> {
		const list = [...this.failoverService.allProviders];
		const [item] = list.splice(index, 1);
		list.splice(index + delta, 0, item);
		await this.failoverService.saveProviders(list);
	}

	private async editModels(index: number, provider: IFailoverProvider): Promise<void> {
		const current = [provider.model, ...(provider.models ?? [])];
		let available: string[] = [];
		try {
			available = await this.localLlamaService.listRemoteModels(provider.url, (await this.failoverService.remoteFor(provider)).apiKey);
		} catch {
			// Not every provider lists models; they are typed instead.
		}
		let chosen: string[] | undefined;
		if (available.length) {
			const items: IQuickPickItem[] = [...new Set([...current, ...available])].map(id => ({ label: id, picked: current.includes(id) }));
			chosen = (await this.quickInputService.pick(items, { canPickMany: true, title: localize('serviced.models.title', "Models on {0}", provider.name), placeHolder: localize('serviced.models.placeholder', "Each one is a route. The first stays the failover choice.") }))?.map(i => i.label);
		} else {
			const typed = await this.quickInputService.input({ title: localize('serviced.models.title', "Models on {0}", provider.name), value: current.join(', '), prompt: localize('serviced.models.prompt', "Model ids, separated by commas. The first stays the failover choice.") });
			chosen = typed?.split(',').map(m => m.trim()).filter(Boolean);
		}
		if (chosen?.length) {
			// Keep the failover choice first when it is still picked.
			const ordered = chosen.includes(provider.model) ? [provider.model, ...chosen.filter(m => m !== provider.model)] : chosen;
			await this.saveProvider(index, { name: provider.name, url: provider.url, model: ordered[0], ...(ordered.length > 1 ? { models: ordered.slice(1) } : {}), ...(provider.enabled === false ? { enabled: false } : {}) });
		}
	}

	private async setKey(provider: IFailoverProvider): Promise<void> {
		const key = await this.quickInputService.input({ title: localize('serviced.key.title', "API Key for {0}", provider.name), prompt: localize('serviced.key.prompt', "Stored in secure storage. Empty removes the key."), password: true });
		if (key !== undefined) {
			await this.failoverService.setApiKey(provider.name, key || undefined);
		}
	}

	private async test(provider: IFailoverProvider): Promise<void> {
		try {
			const models = await this.localLlamaService.listRemoteModels(provider.url, (await this.failoverService.remoteFor(provider)).apiKey);
			this.notificationService.info(localize('serviced.test.ok', "{0} answered: {1} models available.", provider.name, models.length));
		} catch (err) {
			this.notificationService.warn(localize('serviced.test.failed', "{0} did not answer: {1}", provider.name, err instanceof Error ? err.message : String(err)));
		}
	}

	private async remove(provider: IFailoverProvider): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({ message: localize('serviced.remove.confirm', "Remove {0}? Its key is deleted too.", provider.name), primaryButton: localize('serviced.remove.button', "Remove") });
		if (confirmed) {
			await this.failoverService.removeProvider(provider.name);
		}
	}

	// ---- Agent CLIs ------------------------------------------------------------------

	private renderClis(parent: HTMLElement, store: DisposableStore): void {
		heading(parent, localize('serviced.clis', "Installed Agent CLIs"));
		note(parent, localize('serviced.clis.note', "Found on this machine and used with their own sign-in and limits. Headless CLIs cannot ask before acting; what they may do is set under Routing."));
		const agents = this.shellAgentService.cliAgents;
		if (agents.length === 0) {
			append(parent, $('p.hivemindide-lm-empty')).textContent = this.configurationService.getValue<boolean>(HivemindIDESettings.ShellUseInstalledClis) === false
				? localize('serviced.clis.off', "Turned off under Routing.")
				: localize('serviced.clis.none', "None found. Claude Code, Cursor and Codex are picked up when installed.");
		}
		for (const agent of agents) {
			const card = append(parent, $('.hivemindide-sai-card'));
			const head = append(card, $('.hivemindide-sai-card-head'));
			append(head, $('span.hivemindide-sai-name')).textContent = agent.name;
			this.health(head, agent.name, true);
			append(card, $('.hivemindide-lm-model-path')).textContent = `${agent.version} · ${agent.path}`;
			append(card, $('.hivemindide-sai-line')).textContent = localize('serviced.service.models', "Models: {0}", agent.models.join(', '));
			this.statsLine(card, aggregate(this.servicedAIService.allStats, agent.name));
		}
		this.button(append(parent, $('.hivemindide-lm-buttons')), store, localize('serviced.clis.rescan', "Rescan"), true, () => this.commandService.executeCommand(RESCAN_CLIS_COMMAND_ID));
	}

	// ---- Models ----------------------------------------------------------------------

	private renderModels(parent: HTMLElement, store: DisposableStore): void {
		heading(parent, localize('serviced.models', "Models"));
		note(parent, localize('serviced.models.note', "Every model you can run, local, installed CLIs and services alike, and what HivemindIDE knows about each. It starts from the model's name, learns from what it sees (speed, whether it can use tools), and your settings win. Task routing below picks from this list."));
		const catalog = this.shellAgentService.catalog();
		if (catalog.length === 0) {
			append(parent, $('p.hivemindide-lm-empty')).textContent = localize('serviced.models.empty', "No models yet: add a local model, a service, or install an agent CLI.");
		}
		for (const entry of catalog) {
			this.renderModel(parent, store, entry);
		}
	}

	private renderModel(parent: HTMLElement, store: DisposableStore, entry: ICatalogEntry): void {
		const card = append(parent, $('.hivemindide-sai-card.compact'));
		const head = append(card, $('.hivemindide-sai-card-head'));
		append(head, $('span.hivemindide-sai-name')).textContent = entry.route;
		append(head, $('span.hivemindide-sai-kind')).textContent = entry.kind === 'local' ? localize('serviced.kind.local', "local") : entry.kind === 'cli' ? localize('serviced.kind.cli', "CLI") : localize('serviced.kind.api', "API");
		const t = entry.traits;
		const chips = append(card, $('.hivemindide-sai-chips'));
		chip(chips, localize('serviced.trait.reasoning', "Reasoning {0}", levelLabel(t.reasoning)));
		chip(chips, localize('serviced.trait.speed', "Speed {0}", levelLabel(t.speed)));
		chip(chips, costLabel(t.cost));
		chip(chips, t.tools === true ? localize('serviced.trait.tools', "Tools ✓") : t.tools === false ? localize('serviced.trait.noTools', "No tools") : localize('serviced.trait.toolsUnknown', "Tools ?"), t.tools === false ? 'warn' : undefined);
		append(card, $('.hivemindide-sai-line')).textContent = localize('serviced.trait.strengths', "Good at: {0}", t.strengths.map(taskName).join(', ') || '-');
		const sources = entry.sources.filter(s => s === 'measured' || s === 'user').map(s => s === 'measured' ? localize('serviced.source.measured', "measured") : localize('serviced.source.user', "your settings"));
		if (sources.length) {
			append(card, $('.hivemindide-sai-line.dim')).textContent = localize('serviced.source', "Adjusted by {0}", sources.join(', '));
		}
		const actions = append(card, $('.hivemindide-lm-model-actions'));
		this.link(actions, store, localize('serviced.model.edit', "Edit…"), () => this.editTraits(entry));
		if (this.servicedAIService.traitOverrides[entry.route]) {
			this.link(actions, store, localize('serviced.model.reset', "Reset"), () => this.servicedAIService.setTraitOverrides(entry.route, undefined));
		}
	}

	/** One trait at a time: pick which, then its value. */
	private async editTraits(entry: ICatalogEntry): Promise<void> {
		type Field = 'reasoning' | 'speed' | 'cost' | 'tools' | 'strengths';
		const fields: (IQuickPickItem & { field: Field })[] = [
			{ field: 'reasoning', label: localize('serviced.edit.reasoning', "Reasoning"), description: levelLabel(entry.traits.reasoning) },
			{ field: 'speed', label: localize('serviced.edit.speed', "Speed"), description: levelLabel(entry.traits.speed) },
			{ field: 'cost', label: localize('serviced.edit.cost', "Cost"), description: costLabel(entry.traits.cost) },
			{ field: 'tools', label: localize('serviced.edit.tools', "Can use tools (run as an agent)"), description: entry.traits.tools === undefined ? '?' : String(entry.traits.tools) },
			{ field: 'strengths', label: localize('serviced.edit.strengths', "Good at"), description: entry.traits.strengths.map(taskName).join(', ') },
		];
		const field = (await this.quickInputService.pick(fields, { title: localize('serviced.edit.title', "What HivemindIDE Knows About {0}", entry.route) }))?.field;
		if (!field) {
			return;
		}
		const current: ITraitOverrides = this.servicedAIService.traitOverrides[entry.route] ?? {};
		let change: ITraitOverrides | undefined;
		if (field === 'reasoning' || field === 'speed') {
			const levels: Level[] = ['low', 'medium', 'high'];
			const pick = await this.quickInputService.pick(levels.map(l => ({ label: levelLabel(l), level: l, picked: entry.traits[field] === l })), { title: field === 'reasoning' ? localize('serviced.edit.reasoning', "Reasoning") : localize('serviced.edit.speed', "Speed") });
			change = pick && { [field]: pick.level };
		} else if (field === 'cost') {
			const costs: CostLevel[] = ['free', 'subscription', 'low', 'medium', 'high'];
			const pick = await this.quickInputService.pick(costs.map(c => ({ label: costLabel(c), cost: c })), { title: localize('serviced.edit.cost', "Cost") });
			change = pick && { cost: pick.cost };
		} else if (field === 'tools') {
			const pick = await this.quickInputService.pick([
				{ label: localize('serviced.edit.tools.yes', "Yes: it can run as an agent"), value: true },
				{ label: localize('serviced.edit.tools.no', "No: it only answers"), value: false },
			], { title: localize('serviced.edit.tools', "Can use tools (run as an agent)") });
			change = pick && { tools: pick.value };
		} else {
			const picks = await this.quickInputService.pick(TASKS.map(task => ({ label: taskName(task), task, picked: entry.traits.strengths.includes(task) })), { canPickMany: true, title: localize('serviced.edit.strengths', "Good at") });
			change = picks && { strengths: picks.map(p => p.task) };
		}
		if (change) {
			await this.servicedAIService.setTraitOverrides(entry.route, { ...current, ...change });
		}
	}

	private renderTaskRouting(parent: HTMLElement, store: DisposableStore): void {
		heading(parent, localize('serviced.tasks', "Task Routing"));
		note(parent, localize('serviced.tasks.note', "Which model each kind of work runs on. Chats on Auto (by task) follow this, as do the steps any chat hands off: planning a split into sub-agents, and each sub-agent by the kind of task it got. Plan mode is planning; Ask mode is answering; Agent and Edit are coding."));
		const routes = this.shellAgentService.routes.filter(r => r.provider !== AUTO_PROVIDER);
		for (const task of TASKS) {
			const best = this.shellAgentService.rankForTask(task)[0]?.entry.route;
			const pinned = this.servicedAIService.taskRoute(task);
			const options = [
				{ value: '', text: best ? localize('serviced.task.autoNow', "Automatic: now {0}", best) : localize('serviced.task.autoNone', "Automatic: nothing available") },
				...routes.map(r => ({ value: r.id, text: r.id })),
			];
			const row = this.row(parent, taskName(task), taskDescription(task));
			const select = store.add(new SelectBox(options, Math.max(0, options.findIndex(o => o.value === (pinned ?? ''))), this.contextViewService, defaultSelectBoxStyles, { ariaLabel: taskName(task) }));
			select.render(append(row, $('.hivemindide-lm-select')));
			store.add(select.onDidSelect(e => this.servicedAIService.setTaskRoute(task, options[e.index].value || undefined)));
		}
	}

	// ---- Combos ----------------------------------------------------------------------

	private renderCombos(parent: HTMLElement, store: DisposableStore): void {
		heading(parent, localize('serviced.combos', "Combos"));
		note(parent, localize('serviced.combos.note', "A chain of routes under one name, in the model picker as Combo/<name>. The strategy picks where each turn starts; when that route fails, the turn moves down the chain."));
		const combos = this.servicedAIService.combos;
		combos.forEach((combo, index) => this.renderCombo(parent, store, combo, index));
		this.button(append(parent, $('.hivemindide-lm-buttons')), store, localize('serviced.combos.new', "New Combo…"), false, () => this.newCombo());
	}

	private renderCombo(parent: HTMLElement, store: DisposableStore, combo: ICombo, index: number): void {
		const card = append(parent, $('.hivemindide-sai-card'));
		const head = append(card, $('.hivemindide-sai-card-head'));
		append(head, $('span.hivemindide-sai-name')).textContent = `${COMBO_PROVIDER}/${combo.name}`;

		const options: ISelectOptionItem[] = COMBO_STRATEGIES.map(s => ({ text: STRATEGY_LABELS[s] }));
		const select = store.add(new SelectBox(options, Math.max(0, COMBO_STRATEGIES.indexOf(combo.strategy)), this.contextViewService, defaultSelectBoxStyles, { ariaLabel: localize('serviced.combo.strategy', "Strategy") }));
		select.render(append(card, $('.hivemindide-lm-select')));
		store.add(select.onDidSelect(e => this.saveCombo(index, { ...combo, strategy: COMBO_STRATEGIES[e.index] })));

		const list = append(card, $('.hivemindide-sai-targets'));
		if (combo.targets.length === 0) {
			append(list, $('.hivemindide-sai-line.dim')).textContent = localize('serviced.combo.empty', "No targets yet: add the routes this combo chains.");
		}
		combo.targets.forEach((target, t) => {
			const row = append(list, $('.hivemindide-sai-target'));
			append(row, $('span.hivemindide-sai-target-index')).textContent = `${t + 1}.`;
			const label = append(row, $('span.hivemindide-sai-target-route'));
			label.textContent = target.route;
			if (!this.shellAgentService.getRoute(target.route)) {
				label.classList.add('missing');
				label.title = localize('serviced.combo.missing', "No such route any more; turns skip it.");
			}
			if (combo.strategy === 'weighted') {
				const weight = store.add(new InputBox(append(row, $('.hivemindide-sai-weight')), this.contextViewService, { inputBoxStyles: defaultInputBoxStyles, type: 'number', ariaLabel: localize('serviced.combo.weight', "Weight") }));
				weight.value = String(target.weight ?? 1);
				store.add(addDisposableListener(weight.inputElement, 'change', () => {
					const n = Number(weight.value);
					if (Number.isFinite(n) && n > 0) {
						this.saveCombo(index, { ...combo, targets: combo.targets.map((x, i) => i === t ? { route: x.route, weight: n } : x) });
					}
				}));
			}
			const actions = append(row, $('.hivemindide-lm-model-actions'));
			if (t > 0) {
				this.link(actions, store, '↑', () => this.saveCombo(index, { ...combo, targets: swap(combo.targets, t, t - 1) }));
			}
			if (t < combo.targets.length - 1) {
				this.link(actions, store, '↓', () => this.saveCombo(index, { ...combo, targets: swap(combo.targets, t, t + 1) }));
			}
			this.link(actions, store, localize('serviced.combo.removeTarget', "Remove"), () => this.saveCombo(index, { ...combo, targets: combo.targets.filter((_, i) => i !== t) }));
		});
		const actions = append(card, $('.hivemindide-lm-model-actions'));
		this.link(actions, store, localize('serviced.combo.addTarget', "Add targets…"), () => this.addTargets(index, combo));
		this.link(actions, store, localize('serviced.combo.rename', "Rename…"), () => this.renameCombo(index, combo));
		this.link(actions, store, localize('serviced.combo.delete', "Delete"), () => this.servicedAIService.saveCombos(this.servicedAIService.combos.filter((_, i) => i !== index)));
	}

	private async saveCombo(index: number, combo: ICombo): Promise<void> {
		const combos = [...this.servicedAIService.combos];
		combos[index] = combo;
		await this.servicedAIService.saveCombos(combos);
	}

	private async newCombo(): Promise<void> {
		const taken = new Set(this.servicedAIService.combos.map(c => c.name));
		const name = (await this.quickInputService.input({
			title: localize('serviced.combo.newTitle', "New Combo"),
			prompt: localize('serviced.combo.newPrompt', "A name for it, such as coding or cheap."),
			validateInput: async value => !value.trim() ? localize('serviced.combo.nameEmpty', "Enter a name.") : /\//.test(value) ? localize('serviced.combo.nameSlash', "A name cannot contain /.") : taken.has(value.trim()) ? localize('serviced.combo.nameTaken', "There is already a combo named {0}.", value.trim()) : undefined,
		}))?.trim();
		if (!name) {
			return;
		}
		const combo: ICombo = { name, strategy: 'priority', targets: [] };
		await this.servicedAIService.saveCombos([...this.servicedAIService.combos, combo]);
		await this.addTargets(this.servicedAIService.combos.length - 1, combo);
	}

	private async renameCombo(index: number, combo: ICombo): Promise<void> {
		const name = (await this.quickInputService.input({ title: localize('serviced.combo.renameTitle', "Rename Combo"), value: combo.name }))?.trim();
		if (name && name !== combo.name && !name.includes('/')) {
			await this.saveCombo(index, { ...combo, name });
		}
	}

	private async addTargets(index: number, combo: ICombo): Promise<void> {
		const have = new Set(combo.targets.map(t => t.route));
		const items: (IQuickPickItem & { route: string })[] = this.shellAgentService.routes
			.filter(r => r.provider !== COMBO_PROVIDER && !have.has(r.id))
			.map(r => ({ label: r.model, description: r.provider, route: r.id }));
		const picks = await this.quickInputService.pick(items, { canPickMany: true, title: localize('serviced.combo.addTitle', "Add to Combo/{0}", combo.name), placeHolder: localize('serviced.combo.addPlaceholder', "Routes to chain, added in the order picked") });
		if (picks?.length) {
			await this.saveCombo(index, { ...combo, targets: [...combo.targets, ...picks.map(p => ({ route: p.route }))] });
		}
	}

	// ---- Routing ---------------------------------------------------------------------

	private renderRouting(parent: HTMLElement, store: DisposableStore): void {
		heading(parent, localize('serviced.routing', "Routing"));
		const routes = this.shellAgentService.routes;
		const current = this.servicedAIService.defaultRoute ?? '';
		const options = [{ value: '', text: localize('serviced.default.auto', "Automatic") }, ...routes.map(r => ({ value: r.id, text: r.id }))];
		const row = this.row(parent, localize('serviced.default', "New chats start on"), localize('serviced.default.desc', "Any route or combo; Automatic uses the selected local model, else the first route. The model picker still changes it per chat."));
		const select = store.add(new SelectBox(options, Math.max(0, options.findIndex(o => o.value === current)), this.contextViewService, defaultSelectBoxStyles, { ariaLabel: localize('serviced.default', "New chats start on") }));
		select.render(append(row, $('.hivemindide-lm-select')));
		store.add(select.onDidSelect(e => this.servicedAIService.setDefaultRoute(options[e.index].value || undefined)));

		this.settingSelect(parent, store, HivemindIDESettings.FailoverMode, localize('serviced.failover', "When a route runs out"), localize('serviced.failover.desc', "Out of quota, rate-limited, key rejected, or down. A combo first tries its own next target."), [
			{ value: 'ask', text: localize('serviced.failover.ask', "Ask which service to continue on") },
			{ value: 'auto', text: localize('serviced.failover.auto', "Switch to the next service automatically") },
			{ value: 'off', text: localize('serviced.failover.off', "Stop and show the error") },
		]);
		this.settingCheckbox(parent, store, HivemindIDESettings.ShellUseInstalledClis, localize('serviced.clis.use', "Use installed agent CLIs"), localize('serviced.clis.use.desc', "Offer Claude Code, Cursor and Codex as routes and as failover backups."));
		this.settingSelect(parent, store, HivemindIDESettings.ShellCliPermissions, localize('serviced.cliPermissions', "Agent CLIs may"), undefined, [
			{ value: 'readOnly', text: localize('serviced.cliPermissions.readOnly', "Read and plan only") },
			{ value: 'edits', text: localize('serviced.cliPermissions.edits', "Edit files in the workspace") },
			{ value: 'full', text: localize('serviced.cliPermissions.full', "Edit files and run any command") },
		]);
		this.settingCheckbox(parent, store, HivemindIDESettings.ShellAskRouteOnSpawn, localize('serviced.spawn', "Choose a route for each spawned sub-agent"), localize('serviced.spawn.desc', "Off runs sub-agents on their parent's route."));
	}

	// ---- Usage -----------------------------------------------------------------------

	private renderUsage(parent: HTMLElement, store: DisposableStore): void {
		heading(parent, localize('serviced.usage', "Usage"));
		const entries = [...this.servicedAIService.allStats].sort((a, b) => (b[1].lastUsed ?? 0) - (a[1].lastUsed ?? 0));
		if (entries.length === 0) {
			append(parent, $('p.hivemindide-lm-empty')).textContent = localize('serviced.usage.empty', "Nothing yet. Every chat turn and sub-agent is counted here, per route.");
			return;
		}
		for (const [route, stats] of entries) {
			const row = append(parent, $('.hivemindide-sai-usage'));
			append(row, $('.hivemindide-sai-name')).textContent = route;
			this.statsLine(row, stats);
		}
		this.link(append(parent, $('.hivemindide-lm-model-actions')), store, localize('serviced.usage.reset', "Reset usage"), () => this.servicedAIService.resetStats());
	}

	// ---- Helpers ---------------------------------------------------------------------

	private row(parent: HTMLElement, label: string, description: string | undefined): HTMLElement {
		const row = append(parent, $('.hivemindide-lm-row'));
		append(row, $('.hivemindide-lm-label')).textContent = label;
		if (description) {
			append(row, $('.hivemindide-lm-desc')).textContent = description;
		}
		return row;
	}

	private settingCheckbox(parent: HTMLElement, store: DisposableStore, key: HivemindIDESettings, label: string, description: string): void {
		const row = append(parent, $('.hivemindide-lm-row'));
		const head = append(row, $('.hivemindide-lm-check'));
		const checkbox = store.add(new Checkbox(label, this.configurationService.getValue<boolean>(key) !== false, defaultCheckboxStyles));
		append(head, checkbox.domNode);
		append(head, $('span.hivemindide-lm-label')).textContent = label;
		append(row, $('.hivemindide-lm-desc')).textContent = description;
		store.add(checkbox.onChange(() => this.configurationService.updateValue(key, checkbox.checked, ConfigurationTarget.USER)));
	}

	private settingSelect(parent: HTMLElement, store: DisposableStore, key: HivemindIDESettings, label: string, description: string | undefined, options: (ISelectOptionItem & { value: string })[]): void {
		const row = this.row(parent, label, description);
		const current = this.configurationService.getValue<string>(key) ?? '';
		const box = store.add(new SelectBox(options, Math.max(0, options.findIndex(o => o.value === current)), this.contextViewService, defaultSelectBoxStyles, { ariaLabel: label }));
		box.render(append(row, $('.hivemindide-lm-select')));
		store.add(box.onDidSelect(e => this.configurationService.updateValue(key, options[e.index].value, ConfigurationTarget.USER)));
	}

	private button(parent: HTMLElement, store: DisposableStore, label: string, secondary: boolean, run: () => unknown): void {
		const button = store.add(new Button(parent, { ...defaultButtonStyles, secondary }));
		button.label = label;
		store.add(button.onDidClick(() => this.run(run)));
	}

	private link(parent: HTMLElement, store: DisposableStore, label: string, run: () => unknown): void {
		const link = append(parent, $('button.hivemindide-lm-link')) as HTMLButtonElement;
		link.type = 'button';
		link.textContent = label;
		store.add(addDisposableListener(link, 'click', e => {
			e.preventDefault();
			this.run(run);
		}));
	}

	private async run(task: () => unknown): Promise<void> {
		try {
			await task();
		} catch (err) {
			this.notificationService.error(err);
		}
	}
}

/** Everything routed through `provider`, summed over its routes. */
function aggregate(all: ReadonlyMap<string, IRouteStats>, provider: string): IRouteStats | undefined {
	let result: IRouteStats | undefined;
	for (const [route, s] of all) {
		if (route.startsWith(`${provider}/`)) {
			result = {
				requests: (result?.requests ?? 0) + s.requests,
				failures: (result?.failures ?? 0) + s.failures,
				okMs: (result?.okMs ?? 0) + s.okMs,
				lastUsed: Math.max(result?.lastUsed ?? 0, s.lastUsed ?? 0) || undefined,
				lastError: (s.lastUsed ?? 0) >= (result?.lastUsed ?? 0) && s.lastError ? s.lastError : result?.lastError,
			};
		}
	}
	return result;
}

function chip(parent: HTMLElement, text: string, tone?: 'warn'): void {
	const el = append(parent, $('span.hivemindide-sai-chip'));
	el.textContent = text;
	if (tone) {
		el.classList.add(tone);
	}
}

function levelLabel(level: Level): string {
	return level === 'high' ? localize('serviced.level.high', "high") : level === 'medium' ? localize('serviced.level.medium', "medium") : localize('serviced.level.low', "low");
}

function costLabel(cost: CostLevel): string {
	switch (cost) {
		case 'free': return localize('serviced.cost.free', "Free (runs here)");
		case 'subscription': return localize('serviced.cost.subscription', "Subscription");
		case 'low': return localize('serviced.cost.low', "Low cost");
		case 'medium': return localize('serviced.cost.medium', "Medium cost");
		case 'high': return localize('serviced.cost.high', "High cost");
	}
}

function taskName(task: TaskKind): string {
	switch (task) {
		case 'plan': return localize('serviced.task.plan', "Planning");
		case 'code': return localize('serviced.task.code', "Coding");
		case 'ask': return localize('serviced.task.ask', "Answering");
		case 'subagent': return localize('serviced.task.subagent', "Sub-agent work");
		case 'summarize': return localize('serviced.task.summarize', "Summarizing");
	}
}

function taskDescription(task: TaskKind): string {
	switch (task) {
		case 'plan': return localize('serviced.task.planDesc', "Plan mode, and splitting work into sub-agents. Favors the strongest reasoning.");
		case 'code': return localize('serviced.task.codeDesc', "Agent and Edit modes. Needs tools; favors strong, reasonably fast models.");
		case 'ask': return localize('serviced.task.askDesc', "Ask mode and research sub-agents. Balances quality and speed.");
		case 'subagent': return localize('serviced.task.subagentDesc', "Sub-agents that write or change code. Needs tools; favors fast and cheap.");
		case 'summarize': return localize('serviced.task.summarizeDesc', "Summaries and docs. Favors the fastest and cheapest.");
	}
}

function swap<T>(items: readonly T[], a: number, b: number): T[] {
	const copy = [...items];
	[copy[a], copy[b]] = [copy[b], copy[a]];
	return copy;
}

function formatMs(ms: number): string {
	return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

function heading(parent: HTMLElement, text: string): void {
	append(parent, $('.hivemindide-lm-heading')).textContent = text;
}

function note(parent: HTMLElement, text: string): void {
	append(parent, $('p.hivemindide-lm-note')).textContent = text;
}
