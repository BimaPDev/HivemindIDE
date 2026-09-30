/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE local models: the "Local Models" settings section.
 *
 *  Rendered by both the User sidebar's Settings tab and the HivemindIDE
 *  Settings page. Everything here is a view over ILocalModelsService and the
 *  hivemindide.localModels.* settings; API keys go to secret storage.
 *
 *  The section re-renders itself when state changes, but never while an input
 *  inside it has focus — that would throw away what the user is typing. The
 *  deferred render runs when focus leaves.
 *--------------------------------------------------------------------------------------------*/

import './media/localModelsSettings.css';
import { $, addDisposableListener, append, clearNode, getActiveElement, isHTMLElement } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { InputBox } from '../../../../../base/browser/ui/inputbox/inputBox.js';
import { ISelectOptionItem, SelectBox } from '../../../../../base/browser/ui/selectBox/selectBox.js';
import { Checkbox } from '../../../../../base/browser/ui/toggle/toggle.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextViewService } from '../../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { ILocalLlamaDevice, ILocalLlamaService, LocalLlamaServerStatus } from '../../../../../platform/hivemindide/common/localLlama.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles, defaultCheckboxStyles, defaultInputBoxStyles, defaultSelectBoxStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { HivemindIDESettings } from '../../common/hivemindideConfiguration.js';
import { IHivemindIDESettingsSection, IHivemindIDESettingsSectionRenderOptions } from '../hivemindideSettingsSections.js';
import { ILocalModel, ILocalModelsService, LOCAL_MODELS_ADD_COMMAND_ID } from './localModelsService.js';

export class LocalModelsSettingsSection extends Disposable implements IHivemindIDESettingsSection {

	private root: HTMLElement | undefined;
	private readonly content = this._register(new MutableDisposable<DisposableStore>());
	private pendingRender = false;
	private standalone = false;

	private devices: ILocalLlamaDevice[] | undefined;
	private detectingDevices = false;
	private networkAddresses: string[] = [];
	private shareKey: string | undefined;
	private shareKeyVisible = false;
	private hasRemoteKey = false;

	constructor(
		@ILocalModelsService private readonly localModelsService: ILocalModelsService,
		@ILocalLlamaService private readonly localLlamaService: ILocalLlamaService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextViewService private readonly contextViewService: IContextViewService,
		@ICommandService private readonly commandService: ICommandService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@INotificationService private readonly notificationService: INotificationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
	) {
		super();
	}

	render(parent: HTMLElement, options?: IHivemindIDESettingsSectionRenderOptions): void {
		this.standalone = !!options?.standalone;
		this.root = append(parent, $('.hivemindide-lm'));
		this._register(this.localModelsService.onDidChange(() => this.scheduleRender()));
		this._register(addDisposableListener(this.root, 'focusout', () => {
			// Wait for focus to land before deciding whether it left our inputs.
			setTimeout(() => {
				if (this.pendingRender && !this.isEditing()) {
					this.renderNow();
				}
			}, 0);
		}));

		this.localLlamaService.getNetworkAddresses().then(addresses => {
			this.networkAddresses = addresses;
			this.scheduleRender();
		});
		this.localModelsService.getRemoteApiKey().then(key => {
			this.hasRemoteKey = !!key;
			this.scheduleRender();
		});
		this.localModelsService.refresh();
		this.detectDevices();
		this.renderNow();
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

	private async detectDevices(): Promise<void> {
		if (this.detectingDevices) {
			return;
		}
		this.detectingDevices = true;
		this.scheduleRender();
		try {
			this.devices = await this.localLlamaService.listDevices(this.configurationService.getValue<string>(HivemindIDESettings.LocalModelsServerPath) || undefined);
		} catch {
			this.devices = [];
		} finally {
			this.detectingDevices = false;
			this.scheduleRender();
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
		const root = this.root;

		if (!this.standalone) {
			heading(root, localize('lm.section', "Local Models"), true);
			append(root, $('p.hivemindide-lm-intro')).textContent = localize('lm.intro', "Run models with llama.cpp in the Chat panel — on this computer, or on another one.");
		}

		this.checkbox(root, store, HivemindIDESettings.LocalModelsEnabled, localize('lm.enabled', "Enable local models"), localize('lm.enabled.desc', "Turning this off stops any running model and removes the Chat panel's local agent."));
		if (!this.localModelsService.enabled) {
			return;
		}

		this.select(root, store, HivemindIDESettings.LocalModelsEndpoint, localize('lm.endpoint', "Run models on"), undefined, [
			{ value: 'local', text: localize('lm.endpoint.local', "This computer (llama.cpp)") },
			{ value: 'remote', text: localize('lm.endpoint.remote', "Another computer (remote server)") },
		]);

		if (this.localModelsService.endpoint === 'remote') {
			this.renderRemote(root, store);
		} else {
			this.renderStatus(root, store);
			this.renderModels(root, store);
			this.renderGpu(root, store);
			this.renderPerformance(root, store);
			this.renderSharing(root, store);
		}
		this.renderWorkspaceSearch(root, store);
	}

	// ---- Local -----------------------------------------------------------------------

	private renderStatus(parent: HTMLElement, store: DisposableStore): void {
		const box = append(parent, $('.hivemindide-lm-status'));
		const engine = this.localModelsService.engine;
		const engineLine = append(box, $('.hivemindide-lm-status-line'));
		appendIcon(engineLine, engine ? Codicon.check : Codicon.warning);
		append(engineLine, $('span')).textContent = engine
			? localize('lm.engine.ready', "llama.cpp engine: {0}", engine.source === 'managed' ? localize('lm.engine.managed', "installed by HivemindIDE") : engine.path)
			+ (engine.gpu === false ? ` ${engine.gpuBuildAvailable ? localize('lm.engine.cpuUpgrade', "(CPU only; the GPU build installs with your first chat message)") : localize('lm.engine.cpu', "(CPU only)")}` : '')
			: localize('lm.engine.missing', "No llama.cpp found on this computer. It installs automatically on first use, or choose your own under Custom llama-server.");

		const model = this.localModelsService.chatModel;
		const state = this.localModelsService.getServerState('chat');
		const running = state.status !== LocalLlamaServerStatus.Stopped && state.modelPath === model?.path;
		const serverLine = append(box, $('.hivemindide-lm-status-line'));
		appendIcon(serverLine, state.status === LocalLlamaServerStatus.Error ? Codicon.error : running && state.status === LocalLlamaServerStatus.Ready ? Codicon.pass : Codicon.circleOutline);
		const text = append(serverLine, $('span'));
		if (!model) {
			text.textContent = localize('lm.server.noModel', "No chat model yet.");
		} else if (state.status === LocalLlamaServerStatus.Error) {
			text.textContent = localize('lm.server.error', "{0} stopped: {1}. It restarts with your next message.", model.name, state.error ?? '');
		} else if (running && state.status === LocalLlamaServerStatus.Starting) {
			text.textContent = localize('lm.server.starting', "Loading {0}…", model.name);
		} else if (running) {
			text.textContent = localize('lm.server.running', "{0} is running ({1} token context).", model.name, state.contextSize ?? '?');
		} else {
			text.textContent = localize('lm.server.stopped', "{0} is not loaded. It loads with your first chat message.", model.name);
		}

		const buttons = append(box, $('.hivemindide-lm-buttons'));
		if (!engine) {
			this.button(buttons, store, localize('lm.engine.install', "Install Engine"), false, () => this.run(() => this.localModelsService.ensureEngine()));
		}
		if (model) {
			if (running || state.status === LocalLlamaServerStatus.Error) {
				this.button(buttons, store, localize('lm.server.stop', "Stop"), true, () => this.run(() => this.localModelsService.stopServers()));
			} else {
				this.button(buttons, store, localize('lm.server.start', "Load Now"), true, () => this.run(() => this.localModelsService.ensureChatServer()));
			}
		}
	}

	private renderModels(parent: HTMLElement, store: DisposableStore): void {
		heading(parent, localize('lm.models', "Models"));

		const folderRow = this.row(parent, localize('lm.folder', "Models folder"), localize('lm.folder.desc', "Every .gguf file in this folder (and two levels below) is available automatically. Downloaded models will be saved here."));
		const folderValue = this.configurationService.getValue<string>(HivemindIDESettings.LocalModelsModelsFolder) ?? '';
		this.input(folderRow, store, HivemindIDESettings.LocalModelsModelsFolder, 'text', this.localModelsService.modelsFolder?.fsPath ?? '', folderValue);
		const folderButtons = append(folderRow, $('.hivemindide-lm-buttons'));
		this.button(folderButtons, store, localize('lm.folder.browse', "Browse…"), true, async () => {
			const picked = await this.fileDialogService.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: localize('lm.folder.pick', "Models Folder") });
			if (picked?.[0]) {
				await this.configurationService.updateValue(HivemindIDESettings.LocalModelsModelsFolder, picked[0].fsPath);
			}
		});
		const folder = this.localModelsService.modelsFolder;
		if (folder) {
			this.button(folderButtons, store, localize('lm.folder.reveal', "Reveal"), true, () => this.commandService.executeCommand('revealFileInOS', URI.file(folder.fsPath)));
		}
		this.button(folderButtons, store, localize('lm.folder.rescan', "Rescan"), true, () => this.localModelsService.refresh());

		const models = this.localModelsService.models;
		const list = append(parent, $('.hivemindide-lm-models'));
		if (models.length === 0) {
			append(list, $('p.hivemindide-lm-empty')).textContent = localize('lm.models.empty', "No models yet. Add a .gguf file, or put one in the models folder.");
		}
		const chat = this.localModelsService.chatModel;
		const embedding = this.localModelsService.embeddingModel;
		for (const model of models) {
			this.renderModelRow(list, store, model, model.path === chat?.path, model.path === embedding?.path);
		}
		this.button(append(parent, $('.hivemindide-lm-buttons')), store, localize('lm.models.add', "Add GGUF Model…"), false, () => this.commandService.executeCommand(LOCAL_MODELS_ADD_COMMAND_ID));

		this.number(parent, store, HivemindIDESettings.LocalModelsContextSize, localize('lm.context', "Context size (tokens)"), localize('lm.context.desc', "How much text the model sees at once. Larger uses more memory; 8192 suits most 7-8B models on 16 GB. 0 picks the largest that fits. If the model runs out of memory, this is halved automatically for that model."));
	}

	private renderModelRow(parent: HTMLElement, store: DisposableStore, model: ILocalModel, isChat: boolean, isEmbedding: boolean): void {
		const row = append(parent, $('.hivemindide-lm-model'));
		const info = append(row, $('.hivemindide-lm-model-info'));
		const name = append(info, $('.hivemindide-lm-model-name'));
		name.textContent = model.name;
		if (isChat) {
			append(name, $('span.hivemindide-lm-badge')).textContent = localize('lm.badge.chat', "chat");
		}
		if (isEmbedding) {
			append(name, $('span.hivemindide-lm-badge')).textContent = localize('lm.badge.search', "search");
		}
		const path = append(info, $('.hivemindide-lm-model-path'));
		path.textContent = model.remote ? localize('lm.model.remote', "on the remote server") : model.fromFolder ? localize('lm.model.inFolder', "in models folder") : model.path;
		path.title = model.path;
		const args = model.remote ? '' : this.localModelsService.getModelArgs(model.path);
		if (args) {
			const argsLine = append(info, $('.hivemindide-lm-model-path'));
			argsLine.textContent = localize('lm.model.args', "Launch options: {0}", args);
			argsLine.title = args;
		}

		const actions = append(row, $('.hivemindide-lm-model-actions'));
		if (!isChat) {
			this.link(actions, store, localize('lm.model.useChat', "Use for chat"), () => this.localModelsService.setChatModel(model));
		}
		this.link(actions, store, isEmbedding ? localize('lm.model.unsetSearch', "Stop using for search") : localize('lm.model.useSearch', "Use for search"), () => this.localModelsService.setEmbeddingModel(isEmbedding ? undefined : model));
		if (!model.remote) {
			this.link(actions, store, localize('lm.model.editArgs', "Launch options…"), () => this.editModelArgs(model));
		}
		if (!model.remote && !model.fromFolder) {
			this.link(actions, store, localize('lm.model.remove', "Remove"), () => this.localModelsService.removeModel(model.path));
		}
	}

	private async editModelArgs(model: ILocalModel): Promise<void> {
		const args = await this.quickInputService.input({
			title: localize('lm.model.editArgs.title', "Launch Options: {0}", model.name),
			value: this.localModelsService.getModelArgs(model.path),
			placeHolder: '-ngl 99 -c 32768 --jinja --temp 1.0 --top-p 0.95 --top-k 20',
			prompt: localize('lm.model.editArgs.prompt', "Extra llama-server arguments for this model, used the next time it starts. They override the settings on this page. A pasted command line works too: -m, --host, --port and --api-key are ignored. Empty clears them."),
		});
		if (args !== undefined) {
			await this.localModelsService.setModelArgs(model.path, args);
		}
	}

	private renderGpu(parent: HTMLElement, store: DisposableStore): void {
		heading(parent, localize('lm.gpu', "GPU"));

		const devicesRow = this.row(parent, localize('lm.gpu.devices', "GPUs to use"), localize('lm.gpu.devices.desc', "Leave all checked to use every GPU. Uncheck all to run on the CPU."));
		const selected = this.configurationService.getValue<string[]>(HivemindIDESettings.LocalModelsDevices) ?? [];
		if (this.detectingDevices) {
			append(devicesRow, $('p.hivemindide-lm-empty')).textContent = localize('lm.gpu.detecting', "Detecting GPUs…");
		} else if (!this.devices?.length) {
			append(devicesRow, $('p.hivemindide-lm-empty')).textContent = this.localModelsService.engine
				? localize('lm.gpu.none', "No GPUs found; models run on the CPU.")
				: localize('lm.gpu.needsEngine', "Install the engine to detect GPUs.");
		} else {
			const all = this.devices.map(d => d.id);
			for (const device of this.devices) {
				const checked = selected.length === 0 || selected.includes(device.id);
				const line = append(devicesRow, $('.hivemindide-lm-check'));
				const checkbox = store.add(new Checkbox(device.name, checked, defaultCheckboxStyles));
				append(line, checkbox.domNode);
				append(line, $('span')).textContent = localize('lm.gpu.device', "{0} — {1} ({2} GB free of {3} GB)", device.id, device.name, (device.freeMiB / 1024).toFixed(1), (device.totalMiB / 1024).toFixed(1));
				store.add(checkbox.onChange(() => {
					const current = new Set((this.configurationService.getValue<string[]>(HivemindIDESettings.LocalModelsDevices) ?? []).filter(id => id !== 'none'));
					const effective = current.size === 0 ? new Set(all) : current;
					if (checkbox.checked) {
						effective.add(device.id);
					} else {
						effective.delete(device.id);
					}
					const next = effective.size === all.length ? [] : effective.size === 0 ? ['none'] : all.filter(id => effective.has(id));
					this.configurationService.updateValue(HivemindIDESettings.LocalModelsDevices, next);
				}));
			}
		}
		this.button(append(devicesRow, $('.hivemindide-lm-buttons')), store, localize('lm.gpu.detect', "Detect GPUs"), true, () => this.detectDevices());

		this.number(parent, store, HivemindIDESettings.LocalModelsGpuLayers, localize('lm.gpu.layers', "Layers on GPU"), localize('lm.gpu.layers.desc', "-1 fits as many layers as GPU memory allows (recommended). 999 forces the whole model onto the GPU; 0 runs on the CPU only."));

		heading(parent, localize('lm.multiGpu', "Multiple GPUs"));
		if ((this.devices?.length ?? 0) < 2) {
			append(parent, $('p.hivemindide-lm-note')).textContent = localize('lm.multiGpu.note', "These apply when two or more GPUs are in use.");
		}
		this.select(parent, store, HivemindIDESettings.LocalModelsSplitMode, localize('lm.split', "Combine GPUs by"), undefined, [
			{ value: 'layer', text: localize('lm.split.layer', "Layers (recommended)"), description: localize('lm.split.layer.desc', "Spread layers across the GPUs") },
			{ value: 'row', text: localize('lm.split.row', "Rows"), description: localize('lm.split.row.desc', "Split each layer across the GPUs; can be faster with NVLink") },
			{ value: 'none', text: localize('lm.split.none', "Main GPU only"), description: localize('lm.split.none.desc', "Use just the main GPU") },
		]);
		this.number(parent, store, HivemindIDESettings.LocalModelsMainGpu, localize('lm.mainGpu', "Main GPU"), localize('lm.mainGpu.desc', "Index of the GPU used alone (Main GPU only) or for shared work (Rows). 0 is the first GPU above."));
		this.text(parent, store, HivemindIDESettings.LocalModelsTensorSplit, localize('lm.tensorSplit', "Share per GPU"), localize('lm.tensorSplit.desc', "Comma-separated proportions in GPU order, e.g. 3,1 puts three quarters on the first. Empty splits by free memory."), 'e.g. 3,1');
	}

	private renderPerformance(parent: HTMLElement, store: DisposableStore): void {
		heading(parent, localize('lm.performance', "Performance"));
		this.select(parent, store, HivemindIDESettings.LocalModelsFlashAttention, localize('lm.flash', "Flash attention"), localize('lm.flash.desc', "Faster and lighter on memory where the GPU supports it."), [
			{ value: 'auto', text: localize('lm.flash.auto', "Automatic") },
			{ value: 'on', text: localize('lm.flash.on', "On") },
			{ value: 'off', text: localize('lm.flash.off', "Off") },
		]);
		this.number(parent, store, HivemindIDESettings.LocalModelsThreads, localize('lm.threads', "CPU threads"), localize('lm.threads.desc', "0 lets llama.cpp decide."));
		this.number(parent, store, HivemindIDESettings.LocalModelsKeepAliveMinutes, localize('lm.keepAlive', "Unload after idle (minutes)"), localize('lm.keepAlive.desc', "Frees memory when you are not chatting. 0 keeps the model loaded until you stop it."));
		const serverRow = this.row(parent, localize('lm.serverPath', "Custom llama-server"), localize('lm.serverPath.desc', "Your own llama.cpp: the llama-server executable or the folder it is in. Empty finds one already on this computer (PATH, Ollama, winget, Homebrew), or installs one."));
		this.input(serverRow, store, HivemindIDESettings.LocalModelsServerPath, 'text', '/path/to/llama.cpp', this.configurationService.getValue<string>(HivemindIDESettings.LocalModelsServerPath) ?? '');
		const serverButtons = append(serverRow, $('.hivemindide-lm-buttons'));
		this.button(serverButtons, store, localize('lm.serverPath.browse', "Browse…"), true, async () => {
			const picked = await this.fileDialogService.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: localize('lm.serverPath.pick', "Folder Containing llama-server") });
			if (picked?.[0]) {
				await this.configurationService.updateValue(HivemindIDESettings.LocalModelsServerPath, picked[0].fsPath);
			}
		});
		if (this.configurationService.getValue<string>(HivemindIDESettings.LocalModelsServerPath)) {
			this.button(serverButtons, store, localize('lm.serverPath.clear', "Use Automatic"), true, () => this.configurationService.updateValue(HivemindIDESettings.LocalModelsServerPath, undefined));
		}
	}

	private renderSharing(parent: HTMLElement, store: DisposableStore): void {
		heading(parent, localize('lm.network', "Network"));
		this.checkbox(parent, store, HivemindIDESettings.LocalModelsShareOnNetwork, localize('lm.share', "Share this computer's model on the network"), localize('lm.share.desc', "Other computers can use the chat model running here by choosing \"Another computer\" and entering the address and key below."));
		if (!this.configurationService.getValue<boolean>(HivemindIDESettings.LocalModelsShareOnNetwork)) {
			return;
		}
		this.number(parent, store, HivemindIDESettings.LocalModelsSharePort, localize('lm.share.port', "Port"), undefined);

		const port = this.configurationService.getValue<number>(HivemindIDESettings.LocalModelsSharePort) || 11435;
		const addressRow = this.row(parent, localize('lm.share.address', "Address"), this.networkAddresses.length ? undefined : localize('lm.share.noNetwork', "No network connection found."));
		for (const address of this.networkAddresses) {
			const line = append(addressRow, $('.hivemindide-lm-copy'));
			append(line, $('code')).textContent = `http://${address}:${port}`;
			this.link(line, store, localize('lm.copy', "Copy"), () => this.clipboardService.writeText(`http://${address}:${port}`));
		}

		const keyRow = this.row(parent, localize('lm.share.key', "API key"), localize('lm.share.key.desc', "Required by every request. Regenerating it disconnects everyone using the old one."));
		const keyLine = append(keyRow, $('.hivemindide-lm-copy'));
		const keyText = append(keyLine, $('code'));
		keyText.textContent = this.shareKey && this.shareKeyVisible ? this.shareKey : '••••••••••••••••';
		this.link(keyLine, store, this.shareKeyVisible ? localize('lm.hide', "Hide") : localize('lm.show', "Show"), async () => {
			this.shareKey = await this.localModelsService.getShareApiKey();
			this.shareKeyVisible = !this.shareKeyVisible;
			this.renderNow();
		});
		this.link(keyLine, store, localize('lm.copy', "Copy"), async () => this.clipboardService.writeText(await this.localModelsService.getShareApiKey()));
		this.link(keyLine, store, localize('lm.regenerate', "Regenerate"), async () => {
			this.shareKey = await this.localModelsService.regenerateShareApiKey();
			this.renderNow();
		});
	}

	// ---- Remote ------------------------------------------------------------------------

	private renderRemote(parent: HTMLElement, store: DisposableStore): void {
		heading(parent, localize('lm.remote', "Remote Server"));
		this.text(parent, store, HivemindIDESettings.LocalModelsRemoteUrl, localize('lm.remote.url', "Server URL"), localize('lm.remote.url.desc', "An OpenAI-compatible server: llama.cpp (port 8080), Ollama (11434), LM Studio (1234), or another HivemindIDE sharing its model."), 'http://192.168.1.20:11435');

		const keyRow = this.row(parent, localize('lm.remote.key', "API key"), localize('lm.remote.key.desc', "Stored in secure storage, not in settings. Leave empty if the server has none."));
		const keyInput = store.add(new InputBox(append(keyRow, $('.hivemindide-lm-input')), this.contextViewService, { inputBoxStyles: defaultInputBoxStyles, type: 'password', placeholder: this.hasRemoteKey ? localize('lm.remote.key.saved', "Saved — type to replace") : '' }));
		store.add(addDisposableListener(keyInput.inputElement, 'change', async () => {
			await this.localModelsService.setRemoteApiKey(keyInput.value || undefined);
			this.hasRemoteKey = !!keyInput.value;
			keyInput.value = '';
			this.scheduleRender();
		}));

		const status = append(parent, $('.hivemindide-lm-status'));
		const line = append(status, $('.hivemindide-lm-status-line'));
		const error = this.localModelsService.remoteError;
		appendIcon(line, error ? Codicon.warning : Codicon.pass);
		append(line, $('span')).textContent = error ?? localize('lm.remote.connected', "Connected — {0} models available.", this.localModelsService.models.length);
		this.button(append(status, $('.hivemindide-lm-buttons')), store, localize('lm.remote.refresh', "Test Connection"), true, () => this.localModelsService.refresh());

		const models = this.localModelsService.models;
		if (models.length) {
			const options = models.map(m => ({ value: m.path, text: m.name }));
			this.select(parent, store, HivemindIDESettings.LocalModelsRemoteChatModel, localize('lm.remote.chat', "Chat model"), undefined, [{ value: '', text: localize('lm.remote.first', "First available") }, ...options]);
		}
	}

	// ---- Shared ------------------------------------------------------------------------

	private renderWorkspaceSearch(parent: HTMLElement, store: DisposableStore): void {
		heading(parent, localize('lm.search', "Workspace Search"));
		this.checkbox(parent, store, HivemindIDESettings.LocalModelsWorkspaceContext, localize('lm.search.enabled', "Add relevant workspace code to chat"), localize('lm.search.enabled.desc', "Indexes the open folder and includes the best-matching snippets with each message."));
		const models = this.localModelsService.models;
		const remote = this.localModelsService.endpoint === 'remote';
		this.select(parent, store, remote ? HivemindIDESettings.LocalModelsRemoteEmbeddingModel : HivemindIDESettings.LocalModelsEmbeddingModel, localize('lm.search.model', "Search by meaning with"), localize('lm.search.model.desc', "An embedding model such as nomic-embed-text finds code by meaning, not just matching words. Without one, search uses keywords."), [
			{ value: '', text: localize('lm.search.keywords', "Keywords only (no model)") },
			...models.map(m => ({ value: m.path, text: m.name })),
		]);
		this.number(parent, store, HivemindIDESettings.LocalModelsMaxContextChunks, localize('lm.search.max', "Snippets per message"), undefined);
	}

	// ---- Controls ------------------------------------------------------------------------

	private row(parent: HTMLElement, label: string, description: string | undefined): HTMLElement {
		const row = append(parent, $('.hivemindide-lm-row'));
		append(row, $('.hivemindide-lm-label')).textContent = label;
		if (description) {
			append(row, $('.hivemindide-lm-desc')).textContent = description;
		}
		return row;
	}

	private checkbox(parent: HTMLElement, store: DisposableStore, key: HivemindIDESettings, label: string, description: string): void {
		const row = append(parent, $('.hivemindide-lm-row'));
		const head = append(row, $('.hivemindide-lm-check'));
		const checkbox = store.add(new Checkbox(label, !!this.configurationService.getValue<boolean>(key), defaultCheckboxStyles));
		append(head, checkbox.domNode);
		append(head, $('span.hivemindide-lm-label')).textContent = label;
		append(row, $('.hivemindide-lm-desc')).textContent = description;
		store.add(checkbox.onChange(() => this.configurationService.updateValue(key, checkbox.checked)));
	}

	private select(parent: HTMLElement, store: DisposableStore, key: HivemindIDESettings, label: string, description: string | undefined, options: (ISelectOptionItem & { value: string })[]): void {
		const row = this.row(parent, label, description);
		const current = this.configurationService.getValue<string>(key) ?? '';
		const selected = Math.max(0, options.findIndex(o => o.value === current));
		const box = store.add(new SelectBox(options, selected, this.contextViewService, defaultSelectBoxStyles, { ariaLabel: label }));
		box.render(append(row, $('.hivemindide-lm-select')));
		store.add(box.onDidSelect(e => this.configurationService.updateValue(key, options[e.index].value)));
	}

	private input(parent: HTMLElement, store: DisposableStore, key: HivemindIDESettings, type: 'text' | 'number', placeholder: string, value: string): InputBox {
		const input = store.add(new InputBox(append(parent, $('.hivemindide-lm-input')), this.contextViewService, { inputBoxStyles: defaultInputBoxStyles, type, placeholder, ariaLabel: placeholder }));
		input.value = value;
		// Commit on change (Enter or blur), not on every keystroke: most of these restart the model.
		store.add(addDisposableListener(input.inputElement, 'change', () => {
			if (type === 'number') {
				const n = Number(input.value);
				if (input.value.trim() !== '' && Number.isFinite(n)) {
					this.configurationService.updateValue(key, n);
				}
			} else {
				this.configurationService.updateValue(key, input.value.trim());
			}
		}));
		return input;
	}

	private text(parent: HTMLElement, store: DisposableStore, key: HivemindIDESettings, label: string, description: string | undefined, placeholder: string): void {
		const row = this.row(parent, label, description);
		this.input(row, store, key, 'text', placeholder, this.configurationService.getValue<string>(key) ?? '');
	}

	private number(parent: HTMLElement, store: DisposableStore, key: HivemindIDESettings, label: string, description: string | undefined): void {
		const row = this.row(parent, label, description);
		const value = this.configurationService.getValue<number>(key);
		this.input(row, store, key, 'number', '', value === undefined || value === null ? '' : String(value));
	}

	private button(parent: HTMLElement, store: DisposableStore, label: string, secondary: boolean, run: () => unknown): void {
		const button = store.add(new Button(parent, { ...defaultButtonStyles, secondary }));
		button.label = label;
		store.add(button.onDidClick(() => run()));
	}

	private link(parent: HTMLElement, store: DisposableStore, label: string, run: () => unknown): void {
		const link = append(parent, $('button.hivemindide-lm-link')) as HTMLButtonElement;
		link.type = 'button';
		link.textContent = label;
		store.add(addDisposableListener(link, 'click', e => {
			e.preventDefault();
			run();
		}));
	}

	private async run(task: () => Promise<unknown>): Promise<void> {
		try {
			await task();
		} catch (err) {
			this.notificationService.error(err);
		}
	}
}

function heading(parent: HTMLElement, text: string, primary = false): void {
	append(parent, $(primary ? '.hivemindide-lm-heading.primary' : '.hivemindide-lm-heading')).textContent = text;
}

function appendIcon(parent: HTMLElement, icon: ThemeIcon): void {
	append(parent, $('span')).classList.add(...ThemeIcon.asClassNameArray(icon));
}
