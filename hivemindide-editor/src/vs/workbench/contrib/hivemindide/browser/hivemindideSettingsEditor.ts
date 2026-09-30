/*---------------------------------------------------------------------------------------------
 *  HivemindIDE settings editor pane — product settings with a VS Code Settings escape hatch.
 *--------------------------------------------------------------------------------------------*/

import './media/hivemindideSettings.css';
import { $, append, clearNode, Dimension } from '../../../../base/browser/dom.js';
import { Button } from '../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../base/browser/ui/inputbox/inputBox.js';
import { Checkbox } from '../../../../base/browser/ui/toggle/toggle.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { HivemindIDESettingsSections, SELF_RENDERING_CONFIG_PREFIXES } from './hivemindideSettingsSections.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultInputBoxStyles } from '../../../../platform/theme/browser/defaultStyles.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { HIVEMINDIDE_CONFIG_SECTION, HivemindIDESettings } from '../common/hivemindideConfiguration.js';
import { HivemindIDESettingsInput } from './hivemindideSettingsInput.js';

interface IBooleanSettingRow {
	readonly kind: 'boolean';
	readonly key: HivemindIDESettings;
	readonly label: string;
	readonly description: string;
}

interface IStringSettingRow {
	readonly kind: 'string' | 'number';
	readonly key: HivemindIDESettings;
	readonly label: string;
	readonly description: string;
}

type SettingRow = IBooleanSettingRow | IStringSettingRow;

interface ISettingsSection {
	readonly title: string;
	readonly rows: readonly SettingRow[];
}

const SECTIONS: readonly ISettingsSection[] = [
	{
		title: localize('hivemindide.settings.section.usage', "Usage indicator"),
		rows: [
			{
				kind: 'boolean',
				key: HivemindIDESettings.UsageIndicatorEnabled,
				label: localize('hivemindide.settings.usage.enabled', "Show usage indicator"),
				description: localize('hivemindide.usageIndicator.enabled', "Show a status bar indicator with AI coding assistant token usage, read from local tool data. Turning this off removes the indicator and stops all file polling."),
			},
			{
				kind: 'boolean',
				key: HivemindIDESettings.UsageIndicatorShowCost,
				label: localize('hivemindide.settings.usage.showCost', "Show estimated cost"),
				description: localize('hivemindide.usageIndicator.showCost', "Include estimated cost in the usage indicator's tooltip, when the local data reports it."),
			},
			{
				kind: 'number',
				key: HivemindIDESettings.UsageIndicatorDailyTokenBudget,
				label: localize('hivemindide.settings.usage.budget', "Daily token budget"),
				description: localize('hivemindide.settings.usage.budgetDesc', "Used to render usage as a percentage. Set to 0 to show the raw token count instead."),
			},
			{
				kind: 'number',
				key: HivemindIDESettings.UsageIndicatorRefreshSeconds,
				label: localize('hivemindide.settings.usage.refresh', "Refresh interval (seconds)"),
				description: localize('hivemindide.usageIndicator.refreshSeconds', "How often to re-read local usage data, in seconds."),
			},
		],
	},
	{
		title: localize('hivemindide.settings.section.usageNotch', "Usage notch"),
		rows: [
			{
				kind: 'boolean',
				key: HivemindIDESettings.UsageNotchEnabled,
				label: localize('hivemindide.settings.usageNotch.enabled', "Show usage notch"),
				description: localize('hivemindide.settings.usageNotch.enabledDesc', "A notch on the window edge with a ring per AI assistant showing how much of its plan limit is used, and an alert as a limit nears. Drag it to any edge; it stays where you put it."),
			},
			{
				kind: 'boolean',
				key: HivemindIDESettings.UsageNotchKeepOpen,
				label: localize('hivemindide.settings.usageNotch.keepOpen', "Keep it open"),
				description: localize('hivemindide.settings.usageNotch.keepOpenDesc', "Show the rings at all times. Off folds the notch into a thin pill that opens when the pointer reaches it."),
			},
			{
				kind: 'boolean',
				key: HivemindIDESettings.UsageNotchUseMacbookNotch,
				label: localize('hivemindide.settings.usageNotch.macbook', "Use the MacBook notch"),
				description: localize('hivemindide.settings.usageNotch.macbookDesc', "On a MacBook with a camera notch, live in the notch itself, visible over any app: the Hivemind cell, the usage rings, what the agents are doing, and their permission requests. Found automatically."),
			},
		],
	},
	{
		title: localize('hivemindide.settings.section.agents', "Agents"),
		rows: [
			{
				kind: 'boolean',
				key: HivemindIDESettings.AgentTreeEnabled,
				label: localize('hivemindide.settings.agents.enabled', "Show Agents sidebar"),
				description: localize('hivemindide.agentTree.enabled', "Show the HivemindIDE Agents sidebar with the author+AI spawn tree."),
			},
			{
				kind: 'string',
				key: HivemindIDESettings.AgentTreeCoordinationUrl,
				label: localize('hivemindide.settings.agents.url', "Coordination URL"),
				description: localize('hivemindide.agentTree.coordinationUrl', "Base URL of coordinationd. Used for the presence stream and live agent.spawned frames."),
			},
			{
				kind: 'string',
				key: HivemindIDESettings.AgentTreeRepoId,
				label: localize('hivemindide.settings.agents.repoId', "Repo ID"),
				description: localize('hivemindide.agentTree.repoId', "Repo ID passed to coordinationd for the agent tree stream. Use the seeded demo id, or your own."),
			},
		],
	},
	{
		title: localize('hivemindide.settings.section.hivemind', "Hivemind"),
		rows: [
			{ kind: 'boolean', key: HivemindIDESettings.HivemindEnabled, label: localize('hivemindide.settings.hivemind.enabled', "Keep a .hivemind folder in each project"), description: localize('hivemindide.settings.hivemind.enabledDesc', "Shared memory any AI (and any teammate's AI) reads before starting and writes to when it stops, so work picks up where it left off. Only trusted workspaces get one.") },
			{ kind: 'boolean', key: HivemindIDESettings.HivemindAgentPointers, label: localize('hivemindide.settings.hivemind.pointers', "Point other AIs to it"), description: localize('hivemindide.settings.hivemind.pointersDesc', "Add a short managed block to AGENTS.md and CLAUDE.md so Claude Code, Codex, Cursor and Copilot use .hivemind too.") },
			{ kind: 'boolean', key: HivemindIDESettings.HivemindIncludeInChat, label: localize('hivemindide.settings.hivemind.chat', "Give the chat AI recent hivemind work"), description: localize('hivemindide.settings.hivemind.chatDesc', "Include the project notes and the latest nodes with every chat message.") },
			{ kind: 'string', key: HivemindIDESettings.HivemindAuthor, label: localize('hivemindide.settings.hivemind.author', "Your name on nodes"), description: localize('hivemindide.settings.hivemind.authorDesc', "So teammates can tell whose AI did what. Empty uses your account name.") },
		],
	},
];

export class HivemindIDESettingsEditor extends EditorPane {

	static readonly ID = 'workbench.editor.hivemindideSettings';

	private container: HTMLElement | undefined;
	private readonly content = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(HivemindIDESettingsEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected override createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.hivemindide-settings'));
		this.container.tabIndex = 0;
		this.container.setAttribute('role', 'document');
		this.container.setAttribute('aria-label', localize('hivemindide.settings.aria', "HivemindIDE Settings"));
	}

	override async setInput(
		input: HivemindIDESettingsInput,
		options: IEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested || !this.container) {
			return;
		}
		this.render();
	}

	override clearInput(): void {
		this.content.clear();
		if (this.container) {
			clearNode(this.container);
		}
		super.clearInput();
	}

	override layout(_dimension: Dimension): void {
		// Scrollable container; nothing to size beyond CSS.
	}

	override focus(): void {
		this.container?.focus();
	}

	private render(): void {
		if (!this.container) {
			return;
		}

		const store = new DisposableStore();
		this.content.value = store;
		clearNode(this.container);

		const inner = append(this.container, $('.hivemindide-settings-inner'));

		const header = append(inner, $('.hivemindide-settings-header'));
		const headerText = append(header, $('div'));
		append(headerText, $('h1.hivemindide-settings-title')).textContent =
			localize('hivemindide.settings.title', "HivemindIDE Settings");
		append(headerText, $('p.hivemindide-settings-subtitle')).textContent =
			localize('hivemindide.settings.subtitle', "Product preferences for HivemindIDE. Open VS Code Settings for the full editor configuration.");

		const vscodeBtn = store.add(new Button(append(header, $('.hivemindide-settings-vscode-btn')), {
			...defaultButtonStyles,
			secondary: true,
		}));
		vscodeBtn.label = localize('hivemindide.settings.openVscode', "VS Code Settings");
		store.add(vscodeBtn.onDidClick(() => {
			this.commandService.executeCommand('workbench.action.openSettings2');
		}));

		for (const section of SECTIONS) {
			this.renderSection(inner, section, store);
		}
		for (const section of HivemindIDESettingsSections.sections) {
			store.add(this.instantiationService.createInstance(section.ctor)).render(append(inner, $('.hivemindide-settings-section')));
		}

		const footer = append(inner, $('.hivemindide-settings-footer'));
		const footerBtn = store.add(new Button(footer, { ...defaultButtonStyles, secondary: true }));
		footerBtn.label = localize('hivemindide.settings.openVscode', "VS Code Settings");
		store.add(footerBtn.onDidClick(() => {
			this.commandService.executeCommand('workbench.action.openSettings2');
		}));

		store.add(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(HIVEMINDIDE_CONFIG_SECTION) && !SELF_RENDERING_CONFIG_PREFIXES.some(prefix => e.affectsConfiguration(prefix))) {
				this.render();
			}
		}));
	}

	private renderSection(parent: HTMLElement, section: ISettingsSection, store: DisposableStore): void {
		const el = append(parent, $('.hivemindide-settings-section'));
		append(el, $('h2.hivemindide-settings-section-title')).textContent = section.title;

		for (const row of section.rows) {
			if (row.kind === 'boolean') {
				this.renderBooleanRow(el, row, store);
			} else {
				this.renderInputRow(el, row, store);
			}
		}
	}

	private renderBooleanRow(parent: HTMLElement, row: IBooleanSettingRow, store: DisposableStore): void {
		const rowEl = append(parent, $('.hivemindide-settings-row'));
		const control = append(rowEl, $('.hivemindide-settings-row-control'));
		const body = append(rowEl, $('.hivemindide-settings-row-body'));
		append(body, $('.hivemindide-settings-row-label')).textContent = row.label;
		append(body, $('p.hivemindide-settings-row-description')).textContent = row.description;

		const checked = !!this.configurationService.getValue<boolean>(row.key);
		const checkbox = store.add(new Checkbox(row.label, checked, defaultCheckboxStyles));
		append(control, checkbox.domNode);
		store.add(checkbox.onChange(() => {
			this.configurationService.updateValue(row.key, checkbox.checked);
		}));
	}

	private renderInputRow(parent: HTMLElement, row: IStringSettingRow, store: DisposableStore): void {
		const rowEl = append(parent, $('.hivemindide-settings-row.hivemindide-settings-row-input'));
		const body = append(rowEl, $('.hivemindide-settings-row-body'));
		append(body, $('.hivemindide-settings-row-label')).textContent = row.label;
		append(body, $('p.hivemindide-settings-row-description')).textContent = row.description;

		const inputContainer = append(rowEl, $('.hivemindide-settings-input'));
		const value = this.configurationService.getValue(row.key);
		const input = store.add(new InputBox(inputContainer, this.contextViewService, {
			inputBoxStyles: defaultInputBoxStyles,
			type: row.kind === 'number' ? 'number' : 'text',
		}));
		input.value = value === undefined || value === null ? '' : String(value);

		let debounce: ReturnType<typeof setTimeout> | undefined;
		store.add(input.onDidChange(text => {
			if (debounce) {
				clearTimeout(debounce);
			}
			debounce = setTimeout(() => {
				if (row.kind === 'number') {
					const n = Number(text);
					if (!Number.isFinite(n)) {
						return;
					}
					this.configurationService.updateValue(row.key, n);
				} else {
					this.configurationService.updateValue(row.key, text);
				}
			}, 300);
		}));
		store.add({ dispose: () => { if (debounce) { clearTimeout(debounce); } } });
	}
}
