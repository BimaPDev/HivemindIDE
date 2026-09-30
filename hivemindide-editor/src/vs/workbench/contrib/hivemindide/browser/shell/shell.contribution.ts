/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE hivemind shell: registration.
 *
 *  The Chat panel's agent is the hivemind shell (shellChatAgent.ts). Routes
 *  appear in the Chat model picker under "Hivemind"; picking one is choosing
 *  the route a chat's node runs on.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { FileAccess } from '../../../../../base/common/network.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { ChatAgentLocation, ChatModeKind } from '../../../chat/common/constants.js';
import { IChatAgentService } from '../../../chat/common/participants/chatAgents.js';
import { PromptsType } from '../../../chat/common/promptSyntax/promptTypes.js';
import { IPromptsService } from '../../../chat/common/promptSyntax/service/promptsService.js';
import { contributedChatModeIcons } from '../../../chat/common/chatModes.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { IChatMessage, ILanguageModelChatInfoOptions, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelChatRequestOptions, ILanguageModelChatResponse, ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { HivemindIDESettings } from '../../common/hivemindideConfiguration.js';
import { findRoute, isLocalRoute, IShellRoute, ROUTE_VENDORS, RouteGroup, routeIdFromModelIdentifier, shellModelIdentifier } from '../../common/shellRoutes.js';
import { COMBO_PROVIDER } from '../../common/servicedRouting.js';
import { AUTO_PROVIDER } from '../../common/modelCatalog.js';
import { IProviderFailoverService } from '../localModels/providerFailoverService.js';
import { IShellAgentService, ShellAgentService } from './shellAgentService.js';
import { HIVEMIND_CHAT_AGENT_ID, HivemindChatAgent } from './shellChatAgent.js';

registerSingleton(IShellAgentService, ShellAgentService, InstantiationType.Delayed);

/** Context sizes are the provider's business; these only bound what callers outside the shell send. */
const ROUTE_INPUT_TOKENS = 128_000;
const ROUTE_OUTPUT_TOKENS = 16_000;
const SETUP_COMMAND_ID = 'hivemindide.shell.setUp';

/** Chat modes HivemindIDE ships, in the order the mode picker should read them after Agent. */
const SHIPPED_MODES: readonly { readonly file: string; readonly name: string; readonly description: string; readonly icon: ThemeIcon }[] = [
	{ file: 'plan.agent.md', name: 'Plan', description: localize('hivemindChat.mode.plan', "Research the task and write a step-by-step plan, without changing anything."), icon: Codicon.listOrdered },
	{ file: 'debug.agent.md', name: 'Debug', description: localize('hivemindChat.mode.debug', "Find the root cause of a bug, then fix it and show that it is fixed."), icon: Codicon.debug },
	{ file: 'multitask.agent.md', name: 'Multitask', description: localize('hivemindChat.mode.multitask', "Split the request into parts and work on them in parallel, each on the model that suits it."), icon: Codicon.layers },
	{ file: 'ask.agent.md', name: 'Ask', description: localize('hivemindChat.mode.ask', "Answer questions about the code, without changing anything."), icon: Codicon.commentDiscussion },
];

/** The model picker's heading for each group of routes. */
const GROUP_NAMES: Record<RouteGroup, string> = {
	hivemind: localize('shell.vendor', "Hivemind"),
	local: localize('shell.vendor.local', "Local"),
	cli: localize('shell.vendor.cli', "CLI"),
	service: localize('shell.vendor.service', "Service (API)"),
};

/**
 * One group of routes as models, one provider per group so the picker lists them
 * under their own headings. The chat agent only reads which one was picked; a
 * request from anything else (inline chat, an extension) goes straight to the
 * route, as a plain completion without the agent.
 */
class ShellLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	constructor(
		private readonly group: RouteGroup,
		@IShellAgentService private readonly shellAgentService: IShellAgentService,
	) {
		super();
		this._register(this.shellAgentService.onDidChange(() => this._onDidChange.fire()));
	}

	async provideLanguageModelChatInfo(_options: ILanguageModelChatInfoOptions, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		const defaultRoute = this.shellAgentService.defaultRoute;
		return this.shellAgentService.routes.filter(route => this.shellAgentService.groupOf(route) === this.group).map(route => ({
			identifier: shellModelIdentifier(route, this.group),
			metadata: {
				extension: new ExtensionIdentifier(nullExtensionDescription.identifier.value),
				id: route.id,
				// "default" alone says nothing: a CLI's default route is shown by the CLI's name.
				name: this.label(route),
				vendor: ROUTE_VENDORS[this.group],
				version: route.provider,
				family: route.provider,
				detail: isLocalRoute(route) ? localize('shell.model.local', "this machine") : route.provider,
				tooltip: route.provider === AUTO_PROVIDER
					? localize('shell.model.tooltipAuto', "Each turn goes to the model that suits its task: the strongest planner in Plan mode, a capable agent for code, a fast one for sub-agents. See Models in the Serviced AI tab.")
					: isLocalRoute(route)
					? localize('shell.model.tooltipLocal', "Runs as a hivemind agent on {0}, served on this machine. Nothing is sent to a provider.", route.model)
					: this.shellAgentService.cliAgentFor(route)
						? localize('shell.model.tooltipCli', "Runs on your installed {0} CLI ({1}), with its own sign-in and usage limits.", route.provider, this.shellAgentService.cliAgentFor(route)!.path)
						: localize('shell.model.tooltip', "Runs as a hivemind agent on {0}. The chat and the workspace context it reads are sent to {1}.", route.model, route.provider),
				maxInputTokens: ROUTE_INPUT_TOKENS,
				maxOutputTokens: ROUTE_OUTPUT_TOKENS,
				isDefaultForLocation: { [ChatAgentLocation.Chat]: route.id === defaultRoute?.id },
				isUserSelectable: true,
				capabilities: { vision: false, toolCalling: true, agentMode: true },
			},
		}));
	}

	/**
	 * How a route reads in the picker. CLI and service routes name their provider, since
	 * one heading holds several; a CLI's own default ("default", "auto") is just the CLI.
	 * Local models need no more than their name under the Local heading.
	 */
	private label(route: IShellRoute): string {
		if (route.provider === AUTO_PROVIDER) {
			return localize('shell.model.auto', "Auto (by task)");
		}
		if (route.provider === COMBO_PROVIDER) {
			return localize('shell.model.combo', "{0} (combo)", route.model);
		}
		if (this.group === 'local') {
			return route.model;
		}
		return /^(default|auto)$/.test(route.model) ? route.provider : `${route.provider} · ${route.model}`;
	}

	async sendChatRequest(identifier: string, messages: IChatMessage[], _from: ExtensionIdentifier | undefined, _options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		const route = findRoute(this.shellAgentService.routes, routeIdFromModelIdentifier(identifier));
		if (!route) {
			throw new Error(`Unknown hivemind route ${identifier}`);
		}
		return this.shellAgentService.directChat(route, messages, token);
	}

	async provideTokenCount(_identifier: string, message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		const text = typeof message === 'string' ? message : message.content.map(part => part.type === 'text' ? part.value : '').join('');
		return Math.ceil(text.length / 4);
	}
}

class ShellChatContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.hivemindide.shellChat';

	constructor(
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@IShellAgentService shellAgentService: IShellAgentService,
		@IChatAgentService chatAgentService: IChatAgentService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IPromptsService promptsService: IPromptsService,
	) {
		super();

		// The modes beside Agent ship with HivemindIDE (upstream's came with the Copilot extension,
		// which is gone). Their names are what Auto routes by: Plan runs on the best planner,
		// Ask on the best answerer, Debug on the best coder, and Multitask splits into sub-agents.
		for (const mode of SHIPPED_MODES) {
			const uri = FileAccess.asFileUri(`vs/workbench/contrib/hivemindide/browser/shell/modes/${mode.file}`);
			contributedChatModeIcons.set(uri.toString(), mode.icon);
			this._register(promptsService.registerContributedFile(PromptsType.agent, uri, nullExtensionDescription, mode.name, mode.description));
			this._register({ dispose: () => contributedChatModeIcons.delete(uri.toString()) });
		}

		// The Chat panel's one agent: every chat runs in the hivemind shell.
		this._register(chatAgentService.registerAgent(HIVEMIND_CHAT_AGENT_ID, {
			id: HIVEMIND_CHAT_AGENT_ID,
			name: 'hivemind',
			fullName: localize('hivemindChat.fullName', "Hivemind"),
			description: localize('hivemindChat.description', "Runs as an agent on the route you pick"),
			isDefault: true,
			isCore: true,
			locations: [ChatAgentLocation.Chat],
			modes: [ChatModeKind.Ask, ChatModeKind.Edit, ChatModeKind.Agent],
			metadata: { themeIcon: Codicon.chip },
			slashCommands: [{ name: 'continue', description: localize('hivemindChat.continue', "Pick up a hivemind node where it left off") }],
			disambiguation: [],
			extensionId: nullExtensionDescription.identifier,
			extensionVersion: undefined,
			extensionDisplayName: nullExtensionDescription.name,
			extensionPublisherId: nullExtensionDescription.publisher,
		}));
		this._register(chatAgentService.registerAgentImplementation(HIVEMIND_CHAT_AGENT_ID, this._register(instantiationService.createInstance(HivemindChatAgent))));

		const groups = Object.keys(ROUTE_VENDORS) as RouteGroup[];
		languageModelsService.deltaLanguageModelChatProviderDescriptors(groups.map(group => ({ vendor: ROUTE_VENDORS[group], displayName: GROUP_NAMES[group], configuration: undefined, managementCommand: SETUP_COMMAND_ID, when: undefined })), []);
		for (const group of groups) {
			this._register(languageModelsService.registerLanguageModelProvider(ROUTE_VENDORS[group], this._register(instantiationService.createInstance(ShellLanguageModelProvider, group))));
		}
		const refresh = () => groups.forEach(group => languageModelsService.selectLanguageModels({ vendor: ROUTE_VENDORS[group] }));
		this._register(shellAgentService.onDidChange(refresh));
		refresh();
	}
}

registerWorkbenchContribution2(ShellChatContribution.ID, ShellChatContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'hivemindide.shell.rescanClis', title: localize2('shell.rescanClis', "Rescan for Agent CLIs"), category: localize2('hivemindide.category', "HivemindIDE"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const shellAgentService = accessor.get(IShellAgentService);
		const notificationService = accessor.get(INotificationService);
		const agents = await shellAgentService.detectCliAgents();
		notificationService.info(agents.length
			? localize('shell.rescan.found', "Agent CLIs available as routes: {0}.", agents.map(a => `${a.name} ${a.version}`).join(', '))
			: localize('shell.rescan.none', "No agent CLIs found. Install Claude Code, Cursor or Codex, then rescan."));
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: SETUP_COMMAND_ID, title: localize2('shell.setUp', "Choose Hivemind Agent Runtime Folder…"), category: localize2('hivemindide.category', "HivemindIDE"), f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const configurationService = accessor.get(IConfigurationService);
		const failoverService = accessor.get(IProviderFailoverService);
		const notificationService = accessor.get(INotificationService);
		// Only needed when the runtime is not beside the editor, where it is found by itself.
		const picked = await fileDialogService.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: localize('shell.setUp.pick', "Built hivemind-agent Folder") });
		if (!picked?.[0]) {
			return;
		}
		await configurationService.updateValue(HivemindIDESettings.ShellRuntimePath, picked[0].fsPath, ConfigurationTarget.USER);
		notificationService.info(failoverService.providers.length
			? localize('shell.setUp.done', "Chats now run on the hivemind agent runtime in {0}.", picked[0].fsPath)
			: localize('shell.setUp.noRoutes', "Chats now run on the hivemind agent runtime in {0}. Add a local model or an AI provider to run them on.", picked[0].fsPath));
	}
});
