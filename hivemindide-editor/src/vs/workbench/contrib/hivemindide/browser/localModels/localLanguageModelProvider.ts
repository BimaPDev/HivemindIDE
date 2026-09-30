/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE local models: language-model vendor for the chat model picker.
 *
 *  Registers each configured GGUF file as a model under the `hivemindide-local`
 *  vendor. Anything that goes through ILanguageModelsService — the chat panel,
 *  and extensions using the `vscode.lm` API — can then use a local model, and
 *  the first request to a model starts llama.cpp with it.
 *--------------------------------------------------------------------------------------------*/

import { AsyncIterableSource, DeferredPromise } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ILocalLlamaChatOptions, ILocalLlamaMessage, ILocalLlamaService } from '../../../../../platform/hivemindide/common/localLlama.js';
import { nullExtensionDescription } from '../../../../services/extensions/common/extensions.js';
import { ChatAgentLocation } from '../../../chat/common/constants.js';
import { ChatMessageRole, IChatMessage, IChatResponsePart, ILanguageModelChatInfoOptions, ILanguageModelChatMetadataAndIdentifier, ILanguageModelChatProvider, ILanguageModelChatRequestOptions, ILanguageModelChatResponse } from '../../../chat/common/languageModels.js';
import { ILocalModelsService } from './localModelsService.js';

export const LOCAL_MODELS_VENDOR = 'hivemindide-local';

/** Output budget reserved out of the context window: a quarter of it, at most 2048 tokens. */
export function localMaxOutputTokens(contextSize: number): number {
	return Math.min(2048, Math.floor(contextSize / 4));
}

/** Mime type of the status parts (e.g. "restarting the model") a response stream can carry besides answer text. */
export const LOCAL_NOTICE_MIME_TYPE = 'application/vnd.hivemindide.notice';

export function localModelIdentifier(modelId: string): string {
	return `${LOCAL_MODELS_VENDOR}/${modelId}`;
}

export function isLocalModelIdentifier(identifier: string | undefined): identifier is string {
	return !!identifier && identifier.startsWith(`${LOCAL_MODELS_VENDOR}/`);
}

export class LocalLanguageModelProvider extends Disposable implements ILanguageModelChatProvider {

	readonly onDidChange: Event<void>;

	constructor(
		@ILocalModelsService private readonly localModelsService: ILocalModelsService,
		@ILocalLlamaService private readonly localLlamaService: ILocalLlamaService,
	) {
		super();
		this.onDidChange = this.localModelsService.onDidChangeModels;
	}

	async provideLanguageModelChatInfo(_options: ILanguageModelChatInfoOptions, _token: CancellationToken): Promise<ILanguageModelChatMetadataAndIdentifier[]> {
		if (!this.localModelsService.enabled) {
			return [];
		}
		const contextSize = this.localModelsService.contextSize;
		// The search model stays listed: one model can serve both chat and search.
		return this.localModelsService.models
			.map(model => ({
				identifier: localModelIdentifier(model.id),
				metadata: {
					extension: new ExtensionIdentifier(nullExtensionDescription.identifier.value),
					id: model.id,
					name: model.name,
					vendor: LOCAL_MODELS_VENDOR,
					version: 'gguf',
					family: 'llama.cpp',
					detail: model.remote ? localize('localModels.detail.remote', "remote") : 'llama.cpp',
					tooltip: model.path,
					maxInputTokens: contextSize - localMaxOutputTokens(contextSize),
					maxOutputTokens: localMaxOutputTokens(contextSize),
					maxContextWindowTokens: contextSize,
					// Chats pick local models as Hivemind Shell "Local" routes; listing them
					// here too would show each twice. API callers still reach them.
					isDefaultForLocation: { [ChatAgentLocation.Chat]: false },
					isUserSelectable: false,
					// llama.cpp serves OpenAI-style tool calls for most chat templates,
					// and the picker hides models without it in Agent mode.
					capabilities: { vision: false, toolCalling: true, agentMode: true },
				},
			}));
	}

	async sendChatRequest(identifier: string, messages: IChatMessage[], _from: ExtensionIdentifier | undefined, _options: ILanguageModelChatRequestOptions, token: CancellationToken): Promise<ILanguageModelChatResponse> {
		const modelId = identifier.slice(LOCAL_MODELS_VENDOR.length + 1);
		const model = this.localModelsService.getModel(modelId);
		if (!model) {
			throw new Error(`Unknown local model ${identifier}`);
		}
		await this.localModelsService.ensureChatServer(model);

		const state = this.localModelsService.getServerState('chat');
		const remote = await this.localModelsService.remoteFor(model);
		return streamLlamaChat(this.localLlamaService, messages, { maxTokens: localMaxOutputTokens(state.contextSize ?? this.localModelsService.contextSize), remote }, token);
	}

	async provideTokenCount(_identifier: string, message: string | IChatMessage, _token: CancellationToken): Promise<number> {
		// A round trip to llama.cpp's /tokenize for every count would be accurate and slow;
		// ~4 characters per token is close enough for budgeting.
		const text = typeof message === 'string' ? message : messageText(message);
		return Math.ceil(text.length / 4);
	}
}

/**
 * Sends `messages` through the llama service (the local server, or `options.remote`)
 * and adapts its chunk events to a language-model response. Provider failover uses
 * it to reach backup providers directly.
 */
export function streamLlamaChat(localLlamaService: ILocalLlamaService, messages: readonly IChatMessage[], options: ILocalLlamaChatOptions, token: CancellationToken): ILanguageModelChatResponse {
	const requestId = generateUuid();
	const disposables = new DisposableStore();
	const stream = new AsyncIterableSource<IChatResponsePart>();
	const result = new DeferredPromise<void>();

	disposables.add(localLlamaService.onDidChatChunk(chunk => {
		if (chunk.requestId !== requestId) {
			return;
		}
		if (chunk.notice) {
			stream.emitOne({ type: 'data', mimeType: LOCAL_NOTICE_MIME_TYPE, data: VSBuffer.fromString(chunk.notice) });
		}
		if (chunk.thinking) {
			stream.emitOne({ type: 'thinking', value: chunk.thinking });
		}
		if (chunk.text) {
			stream.emitOne({ type: 'text', value: chunk.text });
		}
		if (chunk.done) {
			disposables.dispose();
			if (chunk.error) {
				const error = new Error(chunk.error);
				stream.reject(error);
				result.error(error);
			} else {
				stream.resolve();
				result.complete();
			}
		}
	}));
	disposables.add(token.onCancellationRequested(() => localLlamaService.cancelChat(requestId)));

	localLlamaService.chat(requestId, messages.map(toLlamaMessage), options).catch(err => {
		// The done chunk normally settles the stream first; this covers failures before any chunk.
		if (!result.isSettled) {
			disposables.dispose();
			stream.reject(err);
			result.error(err);
		}
	});

	return { stream: stream.asyncIterable, result: result.p };
}

function messageText(message: IChatMessage): string {
	return message.content.map(part => part.type === 'text' ? part.value : '').join('');
}

function toLlamaMessage(message: IChatMessage): ILocalLlamaMessage {
	const role = message.role === ChatMessageRole.System ? 'system' : message.role === ChatMessageRole.Assistant ? 'assistant' : 'user';
	return { role, content: messageText(message) };
}
