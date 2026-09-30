/*---------------------------------------------------------------------------------------------
 *  User sidebar — icon rail + content panel inside the sidebar (not the activity bar).
 *--------------------------------------------------------------------------------------------*/

import './media/userSidebar.css';
import { $, append, clearNode } from '../../../../base/browser/dom.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { defaultCheckboxStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { HIVEMINDIDE_CONFIG_SECTION, HivemindIDESettings } from '../common/hivemindideConfiguration.js';
import { HIVEMINDIDE_USER_VIEW_ID, UserRailState, UserRailTab } from '../common/userSidebar.js';
import { HivemindIDESettingsSections, SELF_RENDERING_CONFIG_PREFIXES } from './hivemindideSettingsSections.js';

interface IRailTab {
	readonly id: UserRailTab;
	readonly label: string;
	readonly icon: ThemeIcon;
}

interface IActionRow {
	readonly label: string;
	readonly commandId: string;
	readonly icon: ThemeIcon;
	readonly hint?: string;
}

const RAIL_TABS: readonly IRailTab[] = [
	{ id: 'settings', label: localize('hivemindide.user.rail.settings', "Settings"), icon: Codicon.settingsGear },
	{ id: 'localAI', label: localize('hivemindide.user.rail.localAI', "Local AI"), icon: Codicon.sparkle },
	{ id: 'servicedAI', label: localize('hivemindide.user.rail.servicedAI', "Serviced AI"), icon: Codicon.cloud },
	{ id: 'account', label: localize('hivemindide.user.rail.account', "Account"), icon: Codicon.account },
];

const ACCOUNT_ACTIONS: readonly IActionRow[] = [
	{ label: localize('hivemindide.user.profiles', "Profiles"), commandId: 'workbench.profiles.actions.manageProfiles', icon: Codicon.account },
];

export class UserSidebarViewPane extends ViewPane {

	static readonly ID = HIVEMINDIDE_USER_VIEW_ID;

	private shell: HTMLElement | undefined;
	private railEl: HTMLElement | undefined;
	private contentEl: HTMLElement | undefined;
	private readonly contentStore = this._register(new MutableDisposable<DisposableStore>());
	private readonly railStore = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextViewService private readonly contextViewService: IContextViewService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(HivemindIDESettingsSections.onDidChange(() => {
			this.renderRail();
			this.renderContent();
		}));
		this._register(UserRailState.onDidChangeTab(() => {
			this.renderRail();
			this.renderContent();
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(HIVEMINDIDE_CONFIG_SECTION) && !SELF_RENDERING_CONFIG_PREFIXES.some(prefix => e.affectsConfiguration(prefix)) && UserRailState.tab === 'settings') {
				this.renderContent();
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.shell = append(container, $('.hivemindide-user-shell'));
		this.railEl = append(this.shell, $('.hivemindide-user-rail'));
		this.contentEl = append(this.shell, $('.hivemindide-user-content'));
		this.renderRail();
		this.renderContent();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		if (this.shell) {
			this.shell.style.height = `${height}px`;
			this.shell.style.width = `${width}px`;
		}
	}

	private renderRail(): void {
		if (!this.railEl) {
			return;
		}
		clearNode(this.railEl);
		const store = new DisposableStore();
		this.railStore.value = store;

		// Local AI and Serviced AI only exist where a section provides them (desktop builds).
		const tabs = RAIL_TABS.filter(tab => (tab.id !== 'localAI' && tab.id !== 'servicedAI') || HivemindIDESettingsSections.sectionsFor(tab.id).length > 0);
		for (const tab of tabs) {
			const btn = append(this.railEl, $('button.hivemindide-user-rail-btn')) as HTMLButtonElement;
			btn.type = 'button';
			btn.title = tab.label;
			btn.setAttribute('aria-label', tab.label);
			const active = UserRailState.tab === tab.id;
			btn.setAttribute('aria-pressed', String(active));
			if (active) {
				btn.classList.add('active');
			}

			const icon = append(btn, $('span'));
			icon.classList.add(...ThemeIcon.asClassNameArray(tab.icon));
			icon.setAttribute('aria-hidden', 'true');

			const listener = (e: MouseEvent) => {
				e.preventDefault();
				UserRailState.setTab(tab.id);
			};
			btn.addEventListener('click', listener);
			store.add({ dispose: () => btn.removeEventListener('click', listener) });
		}

		append(this.railEl, $('.hivemindide-user-rail-spacer'));
	}

	private renderContent(): void {
		if (!this.contentEl) {
			return;
		}

		const store = new DisposableStore();
		this.contentStore.value = store;
		clearNode(this.contentEl);

		switch (UserRailState.tab) {
			case 'settings':
				this.renderSettingsContent(this.contentEl, store);
				break;
			case 'localAI':
				this.renderLocalAIContent(this.contentEl, store);
				break;
			case 'servicedAI':
				this.renderServicedAIContent(this.contentEl, store);
				break;
			case 'account':
				this.renderActionsContent(
					this.contentEl,
					store,
					localize('hivemindide.user.accountTitle', "Account"),
					localize('hivemindide.user.accountSubtitle', "Profiles and identity. Sign-in lands here later."),
					ACCOUNT_ACTIONS,
				);
				break;
		}
	}

	private renderSettingsContent(parent: HTMLElement, store: DisposableStore): void {
		append(parent, $('h2.hivemindide-user-content-title')).textContent =
			localize('hivemindide.user.settingsTitle', "HivemindIDE Settings");
		append(parent, $('p.hivemindide-user-content-subtitle')).textContent =
			localize('hivemindide.user.settingsSubtitle', "Product preferences. Open VS Code Settings for the full editor configuration.");

		this.renderAction(parent, store, {
			label: localize('hivemindide.user.vscodeSettings', "VS Code Settings"),
			commandId: 'workbench.action.openSettings2',
			icon: Codicon.settings,
		});

		append(parent, $('.hivemindide-user-section-label')).textContent =
			localize('hivemindide.settings.section.usage', "Usage indicator");
		this.renderBooleanSetting(parent, store, HivemindIDESettings.UsageIndicatorEnabled, localize('hivemindide.settings.usage.enabled', "Show usage indicator"), localize('hivemindide.usageIndicator.enabled', "Show a status bar indicator with AI coding assistant token usage, read from local tool data."));
		this.renderBooleanSetting(parent, store, HivemindIDESettings.UsageIndicatorShowCost, localize('hivemindide.settings.usage.showCost', "Show estimated cost"), localize('hivemindide.usageIndicator.showCost', "Include estimated cost in the usage indicator's tooltip, when the local data reports it."));
		this.renderNumberSetting(parent, store, HivemindIDESettings.UsageIndicatorDailyTokenBudget, localize('hivemindide.settings.usage.budget', "Daily token budget"), localize('hivemindide.settings.usage.budgetDesc', "Used to render usage as a percentage. Set to 0 to show the raw token count instead."));
		this.renderNumberSetting(parent, store, HivemindIDESettings.UsageIndicatorRefreshSeconds, localize('hivemindide.settings.usage.refresh', "Refresh interval (seconds)"), localize('hivemindide.usageIndicator.refreshSeconds', "How often to re-read local usage data, in seconds."));

		append(parent, $('.hivemindide-user-section-label')).textContent =
			localize('hivemindide.settings.section.usageNotch', "Usage notch");
		this.renderBooleanSetting(parent, store, HivemindIDESettings.UsageNotchEnabled, localize('hivemindide.settings.usageNotch.enabled', "Show usage notch"), localize('hivemindide.settings.usageNotch.enabledShort', "A ring per AI assistant on the window edge, filled by how much of its plan limit is used."));
		this.renderBooleanSetting(parent, store, HivemindIDESettings.UsageNotchKeepOpen, localize('hivemindide.settings.usageNotch.keepOpen', "Keep it open"), localize('hivemindide.settings.usageNotch.keepOpenShort', "Off folds it into a pill until the pointer reaches it."));
		this.renderBooleanSetting(parent, store, HivemindIDESettings.UsageNotchUseMacbookNotch, localize('hivemindide.settings.usageNotch.macbook', "Use the MacBook notch"), localize('hivemindide.settings.usageNotch.macbookShort', "On a MacBook with a notch, live in the notch itself, visible over any app."));

		append(parent, $('.hivemindide-user-section-label')).textContent =
			localize('hivemindide.settings.section.agents', "Agents");
		this.renderBooleanSetting(parent, store, HivemindIDESettings.AgentTreeEnabled, localize('hivemindide.settings.agents.enabled', "Show Agents sidebar"), localize('hivemindide.agentTree.enabled', "Show the HivemindIDE Agents sidebar with the author+AI spawn tree."));
		this.renderStringSetting(parent, store, HivemindIDESettings.AgentTreeCoordinationUrl, localize('hivemindide.settings.agents.url', "Coordination URL"), localize('hivemindide.agentTree.coordinationUrl', "Base URL of coordinationd."));
		this.renderStringSetting(parent, store, HivemindIDESettings.AgentTreeRepoId, localize('hivemindide.settings.agents.repoId', "Repo ID"), localize('hivemindide.agentTree.repoId', "Repo ID passed to coordinationd."));

		append(parent, $('.hivemindide-user-section-label')).textContent =
			localize('hivemindide.settings.section.hivemind', "Hivemind");
		this.renderBooleanSetting(parent, store, HivemindIDESettings.HivemindEnabled, localize('hivemindide.settings.hivemind.enabled', "Keep a .hivemind folder in each project"), localize('hivemindide.settings.hivemind.enabledDesc', "Shared memory any AI (and any teammate's AI) reads before starting and writes to when it stops, so work picks up where it left off. Only trusted workspaces get one."));
		this.renderBooleanSetting(parent, store, HivemindIDESettings.HivemindAgentPointers, localize('hivemindide.settings.hivemind.pointers', "Point other AIs to it"), localize('hivemindide.settings.hivemind.pointersDesc', "Add a short managed block to AGENTS.md and CLAUDE.md so Claude Code, Codex, Cursor and Copilot use .hivemind too."));
		this.renderBooleanSetting(parent, store, HivemindIDESettings.HivemindIncludeInChat, localize('hivemindide.settings.hivemind.chat', "Give the chat AI recent hivemind work"), localize('hivemindide.settings.hivemind.chatDesc', "Include the project notes and the latest nodes with every chat message."));
		this.renderStringSetting(parent, store, HivemindIDESettings.HivemindAuthor, localize('hivemindide.settings.hivemind.author', "Your name on nodes"), localize('hivemindide.settings.hivemind.authorDesc', "So teammates can tell whose AI did what. Empty uses your account name."));
	}

	private renderLocalAIContent(parent: HTMLElement, store: DisposableStore): void {
		append(parent, $('h2.hivemindide-user-content-title')).textContent =
			localize('hivemindide.user.localAITitle', "Local AI");
		append(parent, $('p.hivemindide-user-content-subtitle')).textContent =
			localize('hivemindide.user.localAISubtitle', "Run models with llama.cpp in the Chat panel — on this computer, or on another one.");
		for (const section of HivemindIDESettingsSections.sectionsFor('localAI')) {
			store.add(this.instantiationService.createInstance(section.ctor)).render(parent, { standalone: true });
		}
	}

	private renderServicedAIContent(parent: HTMLElement, store: DisposableStore): void {
		append(parent, $('h2.hivemindide-user-content-title')).textContent =
			localize('hivemindide.user.servicedAITitle', "Serviced AI");
		append(parent, $('p.hivemindide-user-content-subtitle')).textContent =
			localize('hivemindide.user.servicedAISubtitle', "AI services you reach over the network: API providers and the agent CLIs installed here. Choose which ones run your chats, chain them into combos, and see how each is doing.");
		for (const section of HivemindIDESettingsSections.sectionsFor('servicedAI')) {
			store.add(this.instantiationService.createInstance(section.ctor)).render(parent, { standalone: true });
		}
	}

	private renderActionsContent(parent: HTMLElement, store: DisposableStore, title: string, subtitle: string, actions: readonly IActionRow[]): void {
		append(parent, $('h2.hivemindide-user-content-title')).textContent = title;
		append(parent, $('p.hivemindide-user-content-subtitle')).textContent = subtitle;
		for (const action of actions) {
			this.renderAction(parent, store, action);
		}
	}

	private renderAction(parent: HTMLElement, store: DisposableStore, action: IActionRow): void {
		const btn = append(parent, $('button.hivemindide-user-action')) as HTMLButtonElement;
		btn.type = 'button';
		const icon = append(btn, $('span.hivemindide-user-action-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(action.icon));
		append(btn, $('span.hivemindide-user-action-label')).textContent = action.label;
		if (action.hint) {
			append(btn, $('span.hivemindide-user-action-hint')).textContent = action.hint;
		}
		const listener = (e: MouseEvent) => {
			e.preventDefault();
			this.commandService.executeCommand(action.commandId);
		};
		btn.addEventListener('click', listener);
		store.add({ dispose: () => btn.removeEventListener('click', listener) });
	}

	private renderBooleanSetting(parent: HTMLElement, store: DisposableStore, key: HivemindIDESettings, label: string, description: string): void {
		const row = append(parent, $('.hivemindide-user-setting-row'));
		const head = append(row, $('.hivemindide-user-setting-row-head'));
		const checkbox = store.add(new Checkbox(label, !!this.configurationService.getValue<boolean>(key), defaultCheckboxStyles));
		append(head, checkbox.domNode);
		append(head, $('p.hivemindide-user-setting-label')).textContent = label;
		append(row, $('p.hivemindide-user-setting-desc')).textContent = description;
		store.add(checkbox.onChange(() => this.configurationService.updateValue(key, checkbox.checked)));
	}

	private renderStringSetting(parent: HTMLElement, store: DisposableStore, key: HivemindIDESettings, label: string, description: string): void {
		const row = append(parent, $('.hivemindide-user-setting-row'));
		append(row, $('p.hivemindide-user-setting-label')).textContent = label;
		append(row, $('p.hivemindide-user-setting-desc')).textContent = description;
		const inputWrap = append(row, $('.hivemindide-user-setting-input'));
		const input = store.add(new InputBox(inputWrap, this.contextViewService, { inputBoxStyles: defaultInputBoxStyles }));
		const value = this.configurationService.getValue(key);
		input.value = value === undefined || value === null ? '' : String(value);
		let debounce: ReturnType<typeof setTimeout> | undefined;
		store.add(input.onDidChange(text => {
			if (debounce) {
				clearTimeout(debounce);
			}
			debounce = setTimeout(() => this.configurationService.updateValue(key, text), 300);
		}));
		store.add({ dispose: () => { if (debounce) { clearTimeout(debounce); } } });
	}

	private renderNumberSetting(parent: HTMLElement, store: DisposableStore, key: HivemindIDESettings, label: string, description: string): void {
		const row = append(parent, $('.hivemindide-user-setting-row'));
		append(row, $('p.hivemindide-user-setting-label')).textContent = label;
		append(row, $('p.hivemindide-user-setting-desc')).textContent = description;
		const inputWrap = append(row, $('.hivemindide-user-setting-input'));
		const input = store.add(new InputBox(inputWrap, this.contextViewService, { inputBoxStyles: defaultInputBoxStyles, type: 'number' }));
		const value = this.configurationService.getValue(key);
		input.value = value === undefined || value === null ? '' : String(value);
		let debounce: ReturnType<typeof setTimeout> | undefined;
		store.add(input.onDidChange(text => {
			if (debounce) {
				clearTimeout(debounce);
			}
			debounce = setTimeout(() => {
				const n = Number(text);
				if (Number.isFinite(n)) {
					this.configurationService.updateValue(key, n);
				}
			}, 300);
		}));
		store.add({ dispose: () => { if (debounce) { clearTimeout(debounce); } } });
	}
}
