/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE local models: registration.
 *
 *  Desktop-only — llama.cpp runs as a child of the main process — so this file
 *  is imported from contrib/hivemindide/electron-browser, never from the
 *  browser entry point that web builds also load.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { LocalLlamaServerStatus } from '../../../../../platform/hivemindide/common/localLlama.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { ILanguageModelsService } from '../../../chat/common/languageModels.js';
import { HIVEMINDIDE_USER_OPEN_LOCAL_AI_COMMAND_ID } from '../../common/userSidebar.js';
import { LOCAL_MODELS_VENDOR, LocalLanguageModelProvider } from './localLanguageModelProvider.js';
import { ILocalModel, ILocalModelsService, LOCAL_MODELS_ADD_COMMAND_ID, LocalModelsService, toLocalModel } from './localModelsService.js';
import { LocalModelsSettingsSection } from './localModelsSettingsSection.js';
import { HivemindIDESettingsSections } from '../hivemindideSettingsSections.js';
// AI providers: chat routes, and backups when a route runs out.
import './providerFailover.contribution.js';

registerSingleton(ILocalModelsService, LocalModelsService, InstantiationType.Delayed);

HivemindIDESettingsSections.register({ id: 'localModels', order: 10, ctor: LocalModelsSettingsSection });

const CATEGORY = localize2('hivemindide.localModels.category', "HivemindIDE Local Models");

const LocalModelsCommands = {
	Add: LOCAL_MODELS_ADD_COMMAND_ID,
	SelectChat: 'hivemindide.localModels.selectChatModel',
	SelectEmbedding: 'hivemindide.localModels.selectEmbeddingModel',
	Remove: 'hivemindide.localModels.removeModel',
	Start: 'hivemindide.localModels.start',
	Stop: 'hivemindide.localModels.stop',
	InstallEngine: 'hivemindide.localModels.installEngine',
	ShowMenu: 'hivemindide.localModels.showMenu',
} as const;

// ---- Chat: the local models' vendor and provider ------------------------------
//
// Chats run in the hivemind shell (see ../shell/), where each local model is a
// "Local" route. This provider keeps them reachable through the language-model
// API for everything else (inline chat, extensions using vscode.lm).

class LocalModelsChatContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.hivemindide.localModelsChat';

	constructor(
		@ILanguageModelsService languageModelsService: ILanguageModelsService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		languageModelsService.deltaLanguageModelChatProviderDescriptors([{ vendor: LOCAL_MODELS_VENDOR, displayName: localize('localModels.vendor', "Local (llama.cpp)"), configuration: undefined, managementCommand: LocalModelsCommands.ShowMenu, when: undefined }], []);
		this._register(languageModelsService.registerLanguageModelProvider(LOCAL_MODELS_VENDOR, this._register(instantiationService.createInstance(LocalLanguageModelProvider))));
		languageModelsService.selectLanguageModels({ vendor: LOCAL_MODELS_VENDOR });
	}
}

// ---- Status bar ---------------------------------------------------------------

class LocalModelsStatusContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.hivemindide.localModelsStatus';

	private readonly entry = this._register(new MutableDisposable<IStatusbarEntryAccessor>());

	constructor(
		@ILocalModelsService private readonly localModelsService: ILocalModelsService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
	) {
		super();
		this._register(this.localModelsService.onDidChange(() => this.update()));
		this.update();
	}

	private update(): void {
		if (!this.localModelsService.enabled) {
			this.entry.clear();
			return;
		}
		const entry = this.render();
		if (this.entry.value) {
			this.entry.value.update(entry);
		} else {
			this.entry.value = this.statusbarService.addEntry(entry, LocalModelsStatusContribution.ID, StatusbarAlignment.RIGHT, 101);
		}
	}

	private render(): IStatusbarEntry {
		const name = localize('localModels.status.name', "Local Model");
		const model = this.localModelsService.chatModel;
		const state = this.localModelsService.getServerState('chat');
		if (!model) {
			return { name, text: `$(chip) ${localize('localModels.status.add', "Add Local Model")}`, ariaLabel: name, command: LocalModelsCommands.Add };
		}

		const running = state.modelPath === model.path;
		let icon = '$(chip)';
		let status = localize('localModels.status.stopped', "Not loaded — starts with your first chat message.");
		if (running && state.status === LocalLlamaServerStatus.Starting) {
			icon = '$(loading~spin)';
			status = localize('localModels.status.starting', "Loading…");
		} else if (running && state.status === LocalLlamaServerStatus.Ready) {
			status = state.reducedForMemory
				? localize('localModels.status.readyReduced', "Running, {0} token context (reduced after running out of memory).", state.contextSize ?? '?')
				: localize('localModels.status.ready', "Running, {0} token context.", state.contextSize ?? '?');
		} else if (state.status === LocalLlamaServerStatus.Error) {
			icon = '$(error)';
			status = localize('localModels.status.error', "Stopped: {0}", state.error ?? '');
		}

		const tooltip = new MarkdownString(undefined, { supportThemeIcons: true });
		tooltip.appendMarkdown(`**${model.name}**\n\n`);
		tooltip.appendText(status);
		tooltip.appendMarkdown(`\n\n${localize('localModels.status.embedding', "Workspace search: {0}", this.localModelsService.embeddingModel ? this.localModelsService.embeddingModel.name : localize('localModels.status.keywords', "keywords"))}`);

		return {
			name,
			text: `${icon} ${model.name}`,
			ariaLabel: localize('localModels.status.aria', "Local model {0}: {1}", model.name, status),
			tooltip,
			command: LocalModelsCommands.ShowMenu,
		};
	}
}

registerWorkbenchContribution2(LocalModelsChatContribution.ID, LocalModelsChatContribution, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(LocalModelsStatusContribution.ID, LocalModelsStatusContribution, WorkbenchPhase.Eventually);

// ---- Commands -----------------------------------------------------------------

interface ICommandPickItem extends IQuickPickItem {
	readonly command: string;
}

interface IModelPickItem extends IQuickPickItem {
	readonly model: ILocalModel | undefined;
}

function modelItems(models: readonly ILocalModel[], selectedPath: string | undefined): IModelPickItem[] {
	return models.map(model => ({
		label: model.name,
		description: model.path === selectedPath ? localize('localModels.pick.current', "current") : undefined,
		detail: model.path,
		model,
	}));
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: LocalModelsCommands.Add, title: localize2('localModels.add', "Add GGUF Model…"), category: CATEGORY, f1: true, icon: Codicon.add });
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const localModelsService = accessor.get(ILocalModelsService);
		const fileDialogService = accessor.get(IFileDialogService);
		const uris = await fileDialogService.showOpenDialog({
			title: localize('localModels.add.title', "Add GGUF Models"),
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: true,
			filters: [{ name: localize('localModels.add.filter', "GGUF models"), extensions: ['gguf'] }],
		});
		if (!uris?.length) {
			return;
		}
		await localModelsService.addModels(uris.map(uri => uri.fsPath));
		if (!localModelsService.chatModel || localModelsService.models.length === uris.length) {
			await localModelsService.setChatModel(toLocalModel(uris[0].fsPath));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: LocalModelsCommands.SelectChat, title: localize2('localModels.selectChat', "Select Chat Model"), category: CATEGORY, f1: true });
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const localModelsService = accessor.get(ILocalModelsService);
		const quickInputService = accessor.get(IQuickInputService);
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);

		const models = localModelsService.models;
		if (models.length === 0) {
			return commandService.executeCommand(LocalModelsCommands.Add);
		}
		const pick = await quickInputService.pick(modelItems(models, localModelsService.chatModel?.path), { placeHolder: localize('localModels.selectChat.placeholder', "Model used for chat") });
		if (!pick?.model) {
			return;
		}
		await localModelsService.setChatModel(pick.model);
		// Load it now if another model was already running, so the switch is not paid on the next message.
		if (localModelsService.getServerState('chat').status === LocalLlamaServerStatus.Ready) {
			localModelsService.ensureChatServer(pick.model).catch(err => notificationService.error(err));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: LocalModelsCommands.SelectEmbedding, title: localize2('localModels.selectEmbedding', "Select Embedding Model for Workspace Search"), category: CATEGORY, f1: true });
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const localModelsService = accessor.get(ILocalModelsService);
		const quickInputService = accessor.get(IQuickInputService);
		const none: IModelPickItem = {
			label: localize('localModels.embedding.none', "None — keyword search only"),
			description: localModelsService.embeddingModel ? undefined : localize('localModels.pick.current', "current"),
			model: undefined,
		};
		const pick = await quickInputService.pick([none, ...modelItems(localModelsService.models, localModelsService.embeddingModel?.path)], {
			placeHolder: localize('localModels.selectEmbedding.placeholder', "An embedding model (e.g. nomic-embed-text) lets chat find code by meaning"),
		});
		if (pick) {
			await localModelsService.setEmbeddingModel(pick.model);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: LocalModelsCommands.Remove, title: localize2('localModels.remove', "Remove Model"), category: CATEGORY, f1: true });
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const localModelsService = accessor.get(ILocalModelsService);
		const quickInputService = accessor.get(IQuickInputService);
		const pick = await quickInputService.pick(modelItems(localModelsService.models, undefined), { placeHolder: localize('localModels.remove.placeholder', "Remove from HivemindIDE (the file stays on disk)") });
		if (pick?.model) {
			await localModelsService.removeModel(pick.model.path);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: LocalModelsCommands.Start, title: localize2('localModels.start', "Start Chat Model"), category: CATEGORY, f1: true });
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const localModelsService = accessor.get(ILocalModelsService);
		const notificationService = accessor.get(INotificationService);
		try {
			await localModelsService.ensureChatServer();
		} catch (err) {
			notificationService.error(err);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: LocalModelsCommands.Stop, title: localize2('localModels.stop', "Stop Local Models"), category: CATEGORY, f1: true });
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ILocalModelsService).stopServers();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: LocalModelsCommands.InstallEngine, title: localize2('localModels.installEngine', "Install llama.cpp Engine"), category: CATEGORY, f1: true });
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const localModelsService = accessor.get(ILocalModelsService);
		const notificationService = accessor.get(INotificationService);
		try {
			const engine = await localModelsService.ensureEngine();
			notificationService.info(localize('localModels.installEngine.done', "llama.cpp is ready: {0}", engine.path));
		} catch (err) {
			notificationService.error(err);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: LocalModelsCommands.ShowMenu, title: localize2('localModels.showMenu', "Manage Local Models"), category: CATEGORY, f1: true });
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const localModelsService = accessor.get(ILocalModelsService);
		const quickInputService = accessor.get(IQuickInputService);
		const commandService = accessor.get(ICommandService);

		const running = localModelsService.getServerState('chat').status !== LocalLlamaServerStatus.Stopped
			|| localModelsService.getServerState('embedding').status !== LocalLlamaServerStatus.Stopped;
		const items: (ICommandPickItem | IQuickPickSeparator)[] = [
			{ label: `$(${Codicon.commentDiscussion.id}) ${localize('localModels.menu.chat', "Open Chat")}`, command: 'workbench.action.chat.open' },
			{ type: 'separator' },
			{ label: `$(${Codicon.chip.id}) ${localize('localModels.menu.chatModel', "Chat Model")}`, description: localModelsService.chatModel?.name ?? localize('localModels.menu.none', "none"), command: LocalModelsCommands.SelectChat },
			{ label: `$(${Codicon.search.id}) ${localize('localModels.menu.embeddingModel', "Workspace Search Model")}`, description: localModelsService.embeddingModel?.name ?? localize('localModels.menu.keywords', "keywords only"), command: LocalModelsCommands.SelectEmbedding },
			{ label: `$(${Codicon.add.id}) ${localize('localModels.menu.add', "Add GGUF Model…")}`, command: LocalModelsCommands.Add },
			{ label: `$(${Codicon.trash.id}) ${localize('localModels.menu.remove', "Remove Model…")}`, command: LocalModelsCommands.Remove },
			{ label: `$(${Codicon.settingsGear.id}) ${localize('localModels.menu.settings', "Local AI Settings")}`, description: localize('localModels.menu.settingsDetail', "GPU, network, performance"), command: HIVEMINDIDE_USER_OPEN_LOCAL_AI_COMMAND_ID },
			{ type: 'separator' },
			running
				? { label: `$(${Codicon.debugStop.id}) ${localize('localModels.menu.stop', "Stop Local Models")}`, description: localize('localModels.menu.stopDetail', "frees memory"), command: LocalModelsCommands.Stop }
				: { label: `$(${Codicon.debugStart.id}) ${localize('localModels.menu.start', "Start Chat Model")}`, command: LocalModelsCommands.Start },
		];
		if (!localModelsService.engine) {
			items.push({ label: `$(${Codicon.cloudDownload.id}) ${localize('localModels.menu.install', "Install llama.cpp Engine")}`, description: '~11 MB', command: LocalModelsCommands.InstallEngine });
		} else {
			items.push({ type: 'separator', label: localize('localModels.menu.engine', "llama.cpp: {0}", localModelsService.engine.path) });
		}

		const pick = await quickInputService.pick(items, { placeHolder: localize('localModels.menu.placeholder', "Local models run on this machine with llama.cpp") });
		if (pick) {
			await commandService.executeCommand(pick.command);
		}
	}
});
