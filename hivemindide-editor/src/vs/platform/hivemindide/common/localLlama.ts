/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE local models: the contract between the workbench and the
 *  llama.cpp server manager in the main process.
 *
 *  Everything that touches a process or the network lives behind this
 *  interface in electron-main. The workbench cannot spawn processes, and its
 *  CSP blocks plain http://127.0.0.1, so chat tokens are streamed over IPC as
 *  `onDidChatChunk` events keyed by request id.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const LOCAL_LLAMA_CHANNEL_NAME = 'hivemindideLocalLlama';

export const ILocalLlamaService = createDecorator<ILocalLlamaService>('hivemindideLocalLlamaService');

/** One server per role: a chat model, and optionally an embedding model for workspace search. */
export type LocalLlamaRole = 'chat' | 'embedding';

export interface ILocalLlamaEngine {
	/** Absolute path of the `llama-server` executable. */
	readonly path: string;
	/** `setting`: the user's serverPath. `managed`: installed by HivemindIDE. `path`: found on PATH or in another app's install (Ollama, Jan, a package manager). */
	readonly source: 'setting' | 'managed' | 'path';
	/** Whether this build can offload to a GPU on this machine (it lists one under `--list-devices`). */
	readonly gpu?: boolean;
	/** This build is CPU-only, but the machine has a GPU the pinned download could use. */
	readonly gpuBuildAvailable?: boolean;
}

export const enum LocalLlamaServerStatus {
	Stopped = 'stopped',
	Starting = 'starting',
	Ready = 'ready',
	Error = 'error',
}

export interface ILocalLlamaServerState {
	readonly role: LocalLlamaRole;
	readonly status: LocalLlamaServerStatus;
	readonly modelPath?: string;
	/** Context window the server actually loaded, in tokens. */
	readonly contextSize?: number;
	/** The context was cut below the configured size because the model ran out of memory. */
	readonly reducedForMemory?: boolean;
	readonly error?: string;
}

export interface ILocalLlamaStartOptions {
	readonly modelPath: string;
	/** Tokens; 0 lets llama.cpp choose the largest context that fits in memory. */
	readonly contextSize: number;
	/** Layers offloaded to the GPU; negative lets llama.cpp fit as many as memory allows. */
	readonly gpuLayers: number;
	/** User-configured `llama-server` path; empty or undefined means managed install, then PATH. */
	readonly serverPath?: string;
	/** llama.cpp device ids (`CUDA0`, `MTL0`); empty means every GPU. */
	readonly devices?: readonly string[];
	readonly splitMode?: 'layer' | 'row' | 'none';
	readonly mainGpu?: number;
	/** Comma-separated proportions per device, e.g. `3,1`. */
	readonly tensorSplit?: string;
	/** 0 or undefined lets llama.cpp choose. */
	readonly threads?: number;
	readonly flashAttention?: 'auto' | 'on' | 'off';
	/** Stop the server after this many idle minutes; 0 or undefined keeps it running. */
	readonly keepAliveMinutes?: number;
	/** Listen on every interface on a fixed port with a fixed key, so other machines can use this server. */
	readonly share?: { readonly port: number; readonly apiKey: string };
	/** The user's own arguments for this model, passed last so they override the ones above. */
	readonly extraArgs?: readonly string[];
}

/** A GPU (or other accelerator) as llama.cpp reports it. */
export interface ILocalLlamaDevice {
	readonly id: string;
	readonly name: string;
	readonly totalMiB: number;
	readonly freeMiB: number;
}

/** An OpenAI-compatible server on another machine: llama.cpp, Ollama, LM Studio, or a sharing HivemindIDE. */
export interface ILocalLlamaRemote {
	readonly url: string;
	readonly apiKey?: string;
	readonly model: string;
	/**
	 * A hosted API (OpenAI, Anthropic, OpenRouter …): send only the model, the
	 * messages and `stream`. They reject llama.cpp extras like `cache_prompt`,
	 * and newer models reject `max_tokens` and `temperature`.
	 */
	readonly standardOnly?: boolean;
}

export interface ILocalLlamaMessage {
	readonly role: 'system' | 'user' | 'assistant';
	readonly content: string;
}

export interface ILocalLlamaChatOptions {
	readonly temperature?: number;
	readonly maxTokens?: number;
	/** Send to this remote server instead of the local chat server. */
	readonly remote?: ILocalLlamaRemote;
}

export interface ILocalLlamaChatChunk {
	readonly requestId: string;
	readonly text?: string;
	/** Reasoning tokens from thinking models, kept apart from the answer. */
	readonly thinking?: string;
	readonly done?: boolean;
	readonly error?: string;
	/** Status to show without adding it to the answer, e.g. that the model is being restarted. */
	readonly notice?: string;
}

export interface ILocalLlamaInstallProgress {
	readonly receivedBytes: number;
	readonly totalBytes: number;
}

export interface ILocalLlamaService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeServerState: Event<ILocalLlamaServerState>;
	readonly onDidChatChunk: Event<ILocalLlamaChatChunk>;
	readonly onDidInstallProgress: Event<ILocalLlamaInstallProgress>;

	/** Finds a usable `llama-server`, or undefined when none is installed. */
	resolveEngine(serverPath?: string): Promise<ILocalLlamaEngine | undefined>;

	/** Downloads the pinned llama.cpp build for this platform, verifying its sha256. */
	installEngine(): Promise<ILocalLlamaEngine>;

	getServerState(role: LocalLlamaRole): Promise<ILocalLlamaServerState>;

	/** Starts (or restarts with a different model) the server for a role. Resolves once it is ready. */
	startServer(role: LocalLlamaRole, options: ILocalLlamaStartOptions): Promise<ILocalLlamaServerState>;

	stopServer(role: LocalLlamaRole): Promise<void>;

	/** Streams a completion as `onDidChatChunk` events; resolves after the `done` chunk is fired. */
	chat(requestId: string, messages: readonly ILocalLlamaMessage[], options: ILocalLlamaChatOptions): Promise<void>;

	cancelChat(requestId: string): Promise<void>;

	/** Embeds texts with the embedding server, or `remote` when given. Vectors are L2-normalised. */
	embed(texts: readonly string[], remote?: ILocalLlamaRemote): Promise<number[][]>;

	/** Devices the engine can offload to, from `llama-server --list-devices`. */
	listDevices(serverPath?: string): Promise<ILocalLlamaDevice[]>;

	/** Model ids a remote OpenAI-compatible server offers (`GET /v1/models`). */
	listRemoteModels(url: string, apiKey?: string): Promise<string[]>;
	/**
	 * The running local chat server as an OpenAI-compatible endpoint, for other
	 * programs on this machine (the hivemind shell). Undefined unless it is ready.
	 */
	chatEndpoint(): Promise<{ readonly url: string; readonly apiKey: string } | undefined>;

	/** This machine's non-internal IPv4 addresses, for showing other machines where to connect. */
	getNetworkAddresses(): Promise<string[]>;
}
