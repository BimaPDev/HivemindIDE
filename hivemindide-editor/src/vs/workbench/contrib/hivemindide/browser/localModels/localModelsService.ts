/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE local models: the workbench's view of the models and the
 *  servers running them.
 *
 *  Settings are the source of truth for configuration; the main process is the
 *  source of truth for what is running. Everything else (model picker, chat
 *  agent, status bar, settings section) reads this.
 *
 *  Two endpoints, one shape: in `local` mode models are GGUF files run by
 *  llama.cpp here; in `remote` mode they are model ids on another machine's
 *  OpenAI-compatible server. Callers see ILocalModel either way.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { stringHash } from '../../../../../base/common/hash.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { basename } from '../../../../../base/common/path.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { ILocalLlamaEngine, ILocalLlamaRemote, ILocalLlamaServerState, ILocalLlamaService, ILocalLlamaStartOptions, LocalLlamaRole, LocalLlamaServerStatus } from '../../../../../platform/hivemindide/common/localLlama.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IProgressService, ProgressLocation } from '../../../../../platform/progress/common/progress.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { HIVEMINDIDE_CONFIG_SECTION, HivemindIDESettings } from '../../common/hivemindideConfiguration.js';

export interface ILocalModel {
	/** Stable id, used in model identifiers. */
	readonly id: string;
	/** Display name: the file name without `.gguf`, or the remote model id. */
	readonly name: string;
	/** Absolute file path (local), or the model id on the remote server. */
	readonly path: string;
	readonly remote?: boolean;
	/** Found by scanning the models folder rather than added by hand. */
	readonly fromFolder?: boolean;
}

export type LocalModelsEndpoint = 'local' | 'remote';

const REMOTE_API_KEY_SECRET = 'hivemindide.localModels.remoteApiKey';
const SHARE_API_KEY_SECRET = 'hivemindide.localModels.shareApiKey';

export const ILocalModelsService = createDecorator<ILocalModelsService>('hivemindideLocalModelsService');

export interface ILocalModelsService {
	readonly _serviceBrand: undefined;

	/** Anything changed: models, selection, engine, server state, remote status. */
	readonly onDidChange: Event<void>;
	/** The set of models or the chat-model selection changed. */
	readonly onDidChangeModels: Event<void>;

	readonly enabled: boolean;
	readonly endpoint: LocalModelsEndpoint;
	readonly models: readonly ILocalModel[];
	readonly chatModel: ILocalModel | undefined;
	readonly embeddingModel: ILocalModel | undefined;
	readonly engine: ILocalLlamaEngine | undefined;
	readonly contextSize: number;
	/** Resolved models folder (the setting, or the default under the data folder). */
	readonly modelsFolder: URI | undefined;
	/** Why the remote model list could not be fetched, if it could not. */
	readonly remoteError: string | undefined;
	getServerState(role: LocalLlamaRole): ILocalLlamaServerState;
	getModel(id: string): ILocalModel | undefined;

	addModels(paths: readonly string[]): Promise<void>;
	removeModel(path: string): Promise<void>;
	setChatModel(model: ILocalModel): Promise<void>;
	setEmbeddingModel(model: ILocalModel | undefined): Promise<void>;
	/** The user's extra `llama-server` arguments for a model file, as typed. */
	getModelArgs(modelPath: string): string;
	/** Empty clears them. Takes effect the next time the model starts. */
	setModelArgs(modelPath: string, args: string): Promise<void>;
	/** Rescans the models folder and, in remote mode, the remote model list. */
	refresh(): Promise<void>;

	getRemoteApiKey(): Promise<string | undefined>;
	setRemoteApiKey(key: string | undefined): Promise<void>;
	/** The key other machines use to reach this one's shared model; created on first use. */
	getShareApiKey(): Promise<string>;
	regenerateShareApiKey(): Promise<string>;

	/** Installs the pinned llama.cpp engine if nothing usable is found. */
	ensureEngine(): Promise<ILocalLlamaEngine>;
	/** Makes `model` (default: the selected chat model) ready to serve. */
	ensureChatServer(model?: ILocalModel): Promise<ILocalLlamaServerState>;
	/** Makes the embedding model ready. Returns false when none is configured. */
	ensureEmbeddingServer(): Promise<boolean>;
	/** Where requests for `model` go when it is remote. */
	remoteFor(model: ILocalModel): Promise<ILocalLlamaRemote | undefined>;
	embed(texts: readonly string[]): Promise<number[][]>;
	stopServers(): Promise<void>;
}

/** Adds a GGUF model; the Chat panel links to it when there is nothing to run on. */
export const LOCAL_MODELS_ADD_COMMAND_ID = 'hivemindide.localModels.addModel';

export function toLocalModel(path: string, fromFolder?: boolean): ILocalModel {
	return {
		id: `gguf-${(stringHash(path, 0) >>> 0).toString(16)}`,
		name: basename(path).replace(/\.gguf$/i, ''),
		path,
		fromFolder,
	};
}

/** Splits a command line the way a shell would for plain arguments: on spaces, keeping quoted runs together. */
export function splitArgs(text: string): string[] {
	const args: string[] = [];
	for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
		args.push(match[1] ?? match[2] ?? match[3]);
	}
	return args;
}

function toRemoteModel(modelId: string): ILocalModel {
	return { id: `remote-${(stringHash(modelId, 0) >>> 0).toString(16)}`, name: modelId, path: modelId, remote: true };
}

export class LocalModelsService extends Disposable implements ILocalModelsService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly _onDidChangeModels = this._register(new Emitter<void>());
	readonly onDidChangeModels = this._onDidChangeModels.event;

	private _engine: ILocalLlamaEngine | undefined;
	private readonly states = new Map<LocalLlamaRole, ILocalLlamaServerState>();
	private folderModels: ILocalModel[] = [];
	private remoteModels: ILocalModel[] = [];
	private _remoteError: string | undefined;
	private _modelsFolder: URI | undefined;
	private gpuInstallFailed = false;

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ILocalLlamaService private readonly localLlamaService: ILocalLlamaService,
		@IProgressService private readonly progressService: IProgressService,
		@IFileService private readonly fileService: IFileService,
		@IPathService private readonly pathService: IPathService,
		@IProductService private readonly productService: IProductService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.localLlamaService.onDidChangeServerState(state => {
			this.states.set(state.role, state);
			this._onDidChange.fire();
		}));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (!e.affectsConfiguration(HIVEMINDIDE_CONFIG_SECTION)) {
				return;
			}
			if ((e.affectsConfiguration(HivemindIDESettings.LocalModelsEnabled) && !this.enabled) || (e.affectsConfiguration(HivemindIDESettings.LocalModelsEndpoint) && this.endpoint === 'remote')) {
				this.stopServers();
			}
			if (e.affectsConfiguration(HivemindIDESettings.LocalModelsEmbeddingModel) && !this.configurationService.getValue<string>(HivemindIDESettings.LocalModelsEmbeddingModel)) {
				this.localLlamaService.stopServer('embedding');
			}
			if (e.affectsConfiguration(HivemindIDESettings.LocalModelsServerPath)) {
				this.refreshEngine();
			}
			if (e.affectsConfiguration(HivemindIDESettings.LocalModelsModelsFolder)) {
				this.scanModelsFolder();
			}
			if (e.affectsConfiguration(HivemindIDESettings.LocalModelsEndpoint) || e.affectsConfiguration(HivemindIDESettings.LocalModelsRemoteUrl)) {
				this.refreshRemoteModels();
			}
			if (e.affectsConfiguration(HivemindIDESettings.LocalModelsShareOnNetwork) || e.affectsConfiguration(HivemindIDESettings.LocalModelsSharePort)) {
				this.applySharing();
			}
			if ([HivemindIDESettings.LocalModelsModels, HivemindIDESettings.LocalModelsChatModel, HivemindIDESettings.LocalModelsEnabled, HivemindIDESettings.LocalModelsEndpoint, HivemindIDESettings.LocalModelsRemoteChatModel, HivemindIDESettings.LocalModelsEmbeddingModel, HivemindIDESettings.LocalModelsContextSize].some(key => e.affectsConfiguration(key))) {
				this._onDidChangeModels.fire();
			}
			this._onDidChange.fire();
		}));

		for (const role of ['chat', 'embedding'] as const) {
			this.localLlamaService.getServerState(role).then(state => {
				this.states.set(role, state);
				this._onDidChange.fire();
			});
		}
		this.refreshEngine();
		this.scanModelsFolder();
		this.refreshRemoteModels();
		this.applySharing();
	}

	get enabled(): boolean {
		return this.configurationService.getValue<boolean>(HivemindIDESettings.LocalModelsEnabled) !== false;
	}

	get endpoint(): LocalModelsEndpoint {
		return this.configurationService.getValue<string>(HivemindIDESettings.LocalModelsEndpoint) === 'remote' ? 'remote' : 'local';
	}

	get models(): readonly ILocalModel[] {
		if (this.endpoint === 'remote') {
			return this.remoteModels;
		}
		const listed = (this.configurationService.getValue<string[]>(HivemindIDESettings.LocalModelsModels) ?? [])
			.filter(p => typeof p === 'string' && p.length > 0)
			.map(p => toLocalModel(p));
		const listedPaths = new Set(listed.map(m => m.path));
		return [...listed, ...this.folderModels.filter(m => !listedPaths.has(m.path))];
	}

	get chatModel(): ILocalModel | undefined {
		const models = this.models;
		if (this.endpoint === 'remote') {
			const selected = this.configurationService.getValue<string>(HivemindIDESettings.LocalModelsRemoteChatModel);
			return models.find(m => m.path === selected) ?? models.find(m => m.path !== this.embeddingModel?.path);
		}
		const selected = this.configurationService.getValue<string>(HivemindIDESettings.LocalModelsChatModel);
		return models.find(m => m.path === selected) ?? models.find(m => m.path !== this.embeddingModel?.path);
	}

	get embeddingModel(): ILocalModel | undefined {
		if (this.endpoint === 'remote') {
			const selected = this.configurationService.getValue<string>(HivemindIDESettings.LocalModelsRemoteEmbeddingModel);
			return selected ? toRemoteModel(selected) : undefined;
		}
		const selected = this.configurationService.getValue<string>(HivemindIDESettings.LocalModelsEmbeddingModel);
		return selected ? toLocalModel(selected) : undefined;
	}

	get engine(): ILocalLlamaEngine | undefined {
		return this._engine;
	}

	get contextSize(): number {
		return this.configurationService.getValue<number>(HivemindIDESettings.LocalModelsContextSize) || 8192;
	}

	get modelsFolder(): URI | undefined {
		return this._modelsFolder;
	}

	get remoteError(): string | undefined {
		return this._remoteError;
	}

	getServerState(role: LocalLlamaRole): ILocalLlamaServerState {
		return this.states.get(role) ?? { role, status: LocalLlamaServerStatus.Stopped };
	}

	getModel(id: string): ILocalModel | undefined {
		return this.models.find(m => m.id === id) ?? (this.embeddingModel?.id === id ? this.embeddingModel : undefined);
	}

	// ---- Model list ------------------------------------------------------------

	async addModels(paths: readonly string[]): Promise<void> {
		const current = this.configurationService.getValue<string[]>(HivemindIDESettings.LocalModelsModels) ?? [];
		const next = [...current];
		for (const path of paths) {
			if (!next.includes(path)) {
				next.push(path);
			}
		}
		await this.configurationService.updateValue(HivemindIDESettings.LocalModelsModels, next);
	}

	async removeModel(path: string): Promise<void> {
		const current = this.configurationService.getValue<string[]>(HivemindIDESettings.LocalModelsModels) ?? [];
		await this.configurationService.updateValue(HivemindIDESettings.LocalModelsModels, current.filter(p => p !== path));
		if (this.configurationService.getValue<string>(HivemindIDESettings.LocalModelsChatModel) === path) {
			await this.configurationService.updateValue(HivemindIDESettings.LocalModelsChatModel, '');
		}
		if (this.configurationService.getValue<string>(HivemindIDESettings.LocalModelsEmbeddingModel) === path) {
			await this.setEmbeddingModel(undefined);
		}
		if (this.getServerState('chat').modelPath === path) {
			await this.localLlamaService.stopServer('chat');
		}
	}

	async setChatModel(model: ILocalModel): Promise<void> {
		await this.configurationService.updateValue(model.remote ? HivemindIDESettings.LocalModelsRemoteChatModel : HivemindIDESettings.LocalModelsChatModel, model.path);
	}

	async setEmbeddingModel(model: ILocalModel | undefined): Promise<void> {
		const key = this.endpoint === 'remote' ? HivemindIDESettings.LocalModelsRemoteEmbeddingModel : HivemindIDESettings.LocalModelsEmbeddingModel;
		await this.configurationService.updateValue(key, model?.path ?? '');
		if (!model) {
			await this.localLlamaService.stopServer('embedding');
		}
	}

	async refresh(): Promise<void> {
		await Promise.all([this.scanModelsFolder(), this.refreshRemoteModels(), this.refreshEngine()]);
	}

	private async scanModelsFolder(): Promise<void> {
		const configured = this.configurationService.getValue<string>(HivemindIDESettings.LocalModelsModelsFolder);
		const folder = configured
			? URI.file(configured)
			: joinPath(await this.pathService.userHome(), this.productService.dataFolderName, 'models');
		this._modelsFolder = folder;

		const found: ILocalModel[] = [];
		const visit = async (uri: URI, depth: number) => {
			let stat;
			try {
				stat = await this.fileService.resolve(uri);
			} catch {
				return; // missing folder: no models, not an error
			}
			for (const child of stat.children ?? []) {
				if (child.isFile && child.name.toLowerCase().endsWith('.gguf')) {
					found.push(toLocalModel(child.resource.fsPath, true));
				} else if (child.isDirectory && depth > 0) {
					await visit(child.resource, depth - 1);
				}
			}
		};
		await visit(folder, 2);

		const changed = found.map(m => m.path).join('\n') !== this.folderModels.map(m => m.path).join('\n');
		this.folderModels = found;
		if (changed) {
			this._onDidChangeModels.fire();
		}
		this._onDidChange.fire();
	}

	// ---- Remote ------------------------------------------------------------------

	private get remoteUrl(): string {
		return (this.configurationService.getValue<string>(HivemindIDESettings.LocalModelsRemoteUrl) ?? '').trim();
	}

	private async refreshRemoteModels(): Promise<void> {
		const previous = this.remoteModels.map(m => m.path).join('\n');
		if (this.endpoint !== 'remote' || !this.remoteUrl) {
			this.remoteModels = [];
			this._remoteError = this.endpoint === 'remote' ? localize('localModels.remote.noUrl', "Enter the remote server's URL.") : undefined;
		} else {
			try {
				const ids = await this.localLlamaService.listRemoteModels(this.remoteUrl, await this.getRemoteApiKey());
				this.remoteModels = ids.map(toRemoteModel);
				this._remoteError = ids.length ? undefined : localize('localModels.remote.empty', "Connected, but the server lists no models.");
			} catch (err) {
				this.remoteModels = [];
				this._remoteError = err instanceof Error ? err.message : String(err);
			}
		}
		if (previous !== this.remoteModels.map(m => m.path).join('\n')) {
			this._onDidChangeModels.fire();
		}
		this._onDidChange.fire();
	}

	getRemoteApiKey(): Promise<string | undefined> {
		return this.secretStorageService.get(REMOTE_API_KEY_SECRET);
	}

	async setRemoteApiKey(key: string | undefined): Promise<void> {
		if (key) {
			await this.secretStorageService.set(REMOTE_API_KEY_SECRET, key);
		} else {
			await this.secretStorageService.delete(REMOTE_API_KEY_SECRET);
		}
		await this.refreshRemoteModels();
	}

	async remoteFor(model: ILocalModel): Promise<ILocalLlamaRemote | undefined> {
		return model.remote ? { url: this.remoteUrl, apiKey: await this.getRemoteApiKey(), model: model.path } : undefined;
	}

	// ---- Sharing -------------------------------------------------------------------

	async getShareApiKey(): Promise<string> {
		return await this.secretStorageService.get(SHARE_API_KEY_SECRET) ?? this.regenerateShareApiKey();
	}

	async regenerateShareApiKey(): Promise<string> {
		const key = `hm-${generateUuid().replace(/-/g, '')}`;
		await this.secretStorageService.set(SHARE_API_KEY_SECRET, key);
		await this.applySharing();
		return key;
	}

	private get sharing(): boolean {
		return this.enabled && this.endpoint === 'local' && !!this.configurationService.getValue<boolean>(HivemindIDESettings.LocalModelsShareOnNetwork);
	}

	/** Sharing means serving, so a shared model is loaded now rather than on first chat. */
	private async applySharing(): Promise<void> {
		const running = this.getServerState('chat').status !== LocalLlamaServerStatus.Stopped;
		if (!this.chatModel || (!this.sharing && !running)) {
			return;
		}
		try {
			await this.ensureChatServer();
		} catch (err) {
			this.logService.warn('[LocalModels] could not apply sharing settings', err);
		}
	}

	// ---- Engine and servers ----------------------------------------------------------

	private get serverPath(): string | undefined {
		return this.configurationService.getValue<string>(HivemindIDESettings.LocalModelsServerPath) || undefined;
	}

	private async refreshEngine(): Promise<void> {
		try {
			this._engine = await this.localLlamaService.resolveEngine(this.serverPath);
		} catch (err) {
			this.logService.warn('[LocalModels] resolving llama-server failed', err);
			this._engine = undefined;
		}
		this._onDidChange.fire();
	}

	async ensureEngine(): Promise<ILocalLlamaEngine> {
		const existing = await this.localLlamaService.resolveEngine(this.serverPath);
		// A CPU-only engine is kept only when a GPU build is not on offer, or already failed to install this session.
		if (existing && (!existing.gpuBuildAvailable || this.gpuInstallFailed)) {
			this._engine = existing;
			return existing;
		}
		try {
			return await this.installEngine();
		} catch (err) {
			if (!existing) {
				throw err;
			}
			this.gpuInstallFailed = true;
			this.logService.warn('[LocalModels] installing the GPU build of llama.cpp failed; using the CPU-only one found', err);
			this._engine = existing;
			this._onDidChange.fire();
			return existing;
		}
	}

	private async installEngine(): Promise<ILocalLlamaEngine> {
		this._engine = await this.progressService.withProgress({
			location: ProgressLocation.Notification,
			title: localize('localModels.installing', "Installing the llama.cpp engine"),
		}, async progress => {
			let reported = 0;
			const listener = this.localLlamaService.onDidInstallProgress(({ receivedBytes, totalBytes }) => {
				if (totalBytes > 0) {
					const percent = Math.floor(receivedBytes / totalBytes * 100);
					progress.report({ message: localize('localModels.installProgress', "{0} of {1} MB", (receivedBytes / 1e6).toFixed(1), (totalBytes / 1e6).toFixed(1)), increment: percent - reported });
					reported = percent;
				}
			});
			try {
				return await this.localLlamaService.installEngine();
			} finally {
				listener.dispose();
			}
		});
		this._onDidChange.fire();
		return this._engine;
	}

	private async startOptions(modelPath: string, contextSize: number, share: boolean): Promise<ILocalLlamaStartOptions> {
		const get = <T>(key: HivemindIDESettings) => this.configurationService.getValue<T>(key);
		return {
			modelPath,
			contextSize,
			gpuLayers: get<number>(HivemindIDESettings.LocalModelsGpuLayers) ?? -1,
			serverPath: this.serverPath,
			devices: get<string[]>(HivemindIDESettings.LocalModelsDevices) ?? [],
			splitMode: get<'layer' | 'row' | 'none'>(HivemindIDESettings.LocalModelsSplitMode) ?? 'layer',
			mainGpu: get<number>(HivemindIDESettings.LocalModelsMainGpu) ?? 0,
			tensorSplit: get<string>(HivemindIDESettings.LocalModelsTensorSplit) ?? '',
			threads: get<number>(HivemindIDESettings.LocalModelsThreads) ?? 0,
			flashAttention: get<'auto' | 'on' | 'off'>(HivemindIDESettings.LocalModelsFlashAttention) ?? 'auto',
			keepAliveMinutes: get<number>(HivemindIDESettings.LocalModelsKeepAliveMinutes) ?? 30,
			share: share ? { port: get<number>(HivemindIDESettings.LocalModelsSharePort) || 11435, apiKey: await this.getShareApiKey() } : undefined,
			extraArgs: splitArgs(this.getModelArgs(modelPath)),
		};
	}

	getModelArgs(modelPath: string): string {
		return this.configurationService.getValue<Record<string, string>>(HivemindIDESettings.LocalModelsModelArgs)?.[modelPath] ?? '';
	}

	async setModelArgs(modelPath: string, args: string): Promise<void> {
		const next = { ...this.configurationService.getValue<Record<string, string>>(HivemindIDESettings.LocalModelsModelArgs) };
		if (args.trim()) {
			next[modelPath] = args.trim();
		} else {
			delete next[modelPath];
		}
		await this.configurationService.updateValue(HivemindIDESettings.LocalModelsModelArgs, next);
	}

	async ensureChatServer(model = this.chatModel): Promise<ILocalLlamaServerState> {
		if (!model) {
			throw new Error(localize('localModels.noModel', "No model is configured. Add a .gguf file first."));
		}
		if (model.remote) {
			return { role: 'chat', status: LocalLlamaServerStatus.Ready, modelPath: model.path, contextSize: this.contextSize };
		}
		await this.ensureEngine();
		// startServer is a no-op when the same model is already running with the same options.
		// The raw setting, where 0 means "fit to memory"; `contextSize` substitutes a number for budgeting.
		const requestedContext = this.configurationService.getValue<number>(HivemindIDESettings.LocalModelsContextSize) ?? 8192;
		return this.localLlamaService.startServer('chat', await this.startOptions(model.path, requestedContext, this.sharing));
	}

	async ensureEmbeddingServer(): Promise<boolean> {
		const model = this.embeddingModel;
		if (!model) {
			return false;
		}
		if (model.remote) {
			return true;
		}
		if (model.path === this.chatModel?.path) {
			// A second copy of the chat model, at full context, can exhaust memory and stall the machine.
			this.logService.warn('[LocalModels] the search model is the chat model; searching by keyword only');
			return false;
		}
		await this.ensureEngine();
		await this.localLlamaService.startServer('embedding', await this.startOptions(model.path, 0, false));
		return true;
	}

	async embed(texts: readonly string[]): Promise<number[][]> {
		const model = this.embeddingModel;
		return this.localLlamaService.embed(texts, model ? await this.remoteFor(model) : undefined);
	}

	async stopServers(): Promise<void> {
		await Promise.all([this.localLlamaService.stopServer('chat'), this.localLlamaService.stopServer('embedding')]);
	}
}
