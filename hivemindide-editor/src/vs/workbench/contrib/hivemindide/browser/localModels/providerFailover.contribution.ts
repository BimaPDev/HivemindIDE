/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE provider failover: the service and the commands that let the
 *  user set it up — which backups, in what order, and whether to ask first.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ILocalLlamaService } from '../../../../../platform/hivemindide/common/localLlama.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { FailoverMode } from '../../common/providerFailover.js';
import { IProviderFailoverService, ProviderFailoverService } from './providerFailoverService.js';

registerSingleton(IProviderFailoverService, ProviderFailoverService, InstantiationType.Delayed);

const CATEGORY = localize2('hivemindide.failover.category', "HivemindIDE");

interface IPreset extends IQuickPickItem {
	readonly name: string;
	readonly url: string;
}

/** Services whose API is OpenAI-compatible under `<url>/chat/completions`. */
const PRESETS: IPreset[] = [
	{ label: 'OpenAI', name: 'OpenAI', url: 'https://api.openai.com/v1' },
	{ label: 'Anthropic', name: 'Anthropic', url: 'https://api.anthropic.com/v1', description: localize('failover.preset.anthropic', "OpenAI-compatible endpoint") },
	{ label: 'OpenRouter', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', description: localize('failover.preset.openrouter', "one key, many models") },
	{ label: localize('failover.preset.custom', "Other OpenAI-Compatible Server…"), name: '', url: '', description: localize('failover.preset.customDetail', "Groq, DeepSeek, Ollama, LM Studio, another machine") },
];

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'hivemindide.failover.addProvider', title: localize2('failover.add', "Add AI Provider…"), category: CATEGORY, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const failoverService = accessor.get(IProviderFailoverService);
		const localLlamaService = accessor.get(ILocalLlamaService);
		const notificationService = accessor.get(INotificationService);

		const preset = await quickInputService.pick(PRESETS, { title: localize('failover.add.title', "Add an AI Provider"), placeHolder: localize('failover.add.preset', "Which provider's models should chats be able to run on?") });
		if (!preset) {
			return;
		}
		const taken = new Set(failoverService.allProviders.map(p => p.name));
		const name = (await quickInputService.input({
			title: localize('failover.add.nameTitle', "Name"),
			prompt: localize('failover.add.namePrompt', "Shown when chat switches to this provider."),
			value: preset.name && !taken.has(preset.name) ? preset.name : '',
			validateInput: async value => !value.trim() ? localize('failover.add.nameEmpty', "Enter a name.") : taken.has(value.trim()) ? localize('failover.add.nameTaken', "A backup provider named {0} already exists.", value.trim()) : undefined,
		}))?.trim();
		if (!name) {
			return;
		}
		const url = preset.url || (await quickInputService.input({
			title: localize('failover.add.urlTitle', "Base URL"),
			placeHolder: 'https://api.groq.com/openai/v1',
			prompt: localize('failover.add.urlPrompt', "Base URL of the OpenAI-compatible API."),
			validateInput: async value => /^https?:\/\/\S+$/.test(value.trim()) ? undefined : localize('failover.add.urlInvalid', "Enter an http:// or https:// URL."),
		}))?.trim();
		if (!url) {
			return;
		}
		const apiKey = await quickInputService.input({
			title: localize('failover.add.keyTitle', "API Key for {0}", name),
			prompt: localize('failover.add.keyPrompt', "Stored in secure storage, never in settings or .hivemind. Leave empty if the server needs none."),
			password: true,
		});
		if (apiKey === undefined) {
			return;
		}

		let ids: string[] = [];
		try {
			ids = await localLlamaService.listRemoteModels(url, apiKey || undefined);
		} catch {
			// Not every provider lists models; the id is typed instead.
		}
		const model = ids.length
			? (await quickInputService.pick(ids.map(id => ({ label: id })), { title: localize('failover.add.modelTitle', "Model on {0}", name), placeHolder: localize('failover.add.modelPick', "Which model should take over?") }))?.label
			: (await quickInputService.input({
				title: localize('failover.add.modelTitle', "Model on {0}", name),
				prompt: localize('failover.add.modelPrompt', "The model id, as the provider names it."),
				validateInput: async value => value.trim() ? undefined : localize('failover.add.modelEmpty', "Enter a model id."),
			}))?.trim();
		if (!model) {
			return;
		}

		await failoverService.addProvider({ name, url, model }, apiKey || undefined);
		const position = failoverService.allProviders.length;
		const mode = failoverService.mode;
		notificationService.info(mode === 'auto'
			? localize('failover.added.auto', "{0} ({1}) is provider #{2}: its models are in the Chat model picker, and chat switches to it automatically when another runs out.", name, model, position)
			: mode === 'off'
				? localize('failover.added.off', "{0} ({1}) is provider #{2}: its models are in the Chat model picker. Failover is off.", name, model, position)
				: localize('failover.added.ask', "{0} ({1}) is provider #{2}: its models are in the Chat model picker, and chat asks before switching to it when another runs out.", name, model, position));
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'hivemindide.failover.setMode', title: localize2('failover.setMode', "Choose What Chat Does When a Provider Runs Out…"), category: CATEGORY, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const failoverService = accessor.get(IProviderFailoverService);
		const current = failoverService.mode;
		const items: (IQuickPickItem & { mode: FailoverMode })[] = [
			{ mode: 'ask', label: localize('failover.mode.ask', "Ask Me Each Time"), detail: localize('failover.mode.askDetail', "Pick a backup provider, or stop. A pick holds until the original provider is back.") },
			{ mode: 'auto', label: localize('failover.mode.auto', "Switch Automatically"), detail: localize('failover.mode.autoDetail', "Continue on the first available backup, in your order, without asking.") },
			{ mode: 'off', label: localize('failover.mode.off', "Never Switch"), detail: localize('failover.mode.offDetail', "Stop with the provider's error. Nothing is sent to a backup.") },
		];
		const pick = await quickInputService.pick(items.map(item => item.mode === current ? { ...item, description: localize('failover.mode.current', "current") } : item), { title: localize('failover.mode.title', "When the Chat Model Runs Out") });
		if (pick) {
			await failoverService.setMode(pick.mode);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'hivemindide.failover.setApiKey', title: localize2('failover.setKey', "Set AI Provider API Key…"), category: CATEGORY, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const failoverService = accessor.get(IProviderFailoverService);
		const provider = await pickProvider(quickInputService, failoverService, accessor.get(INotificationService), localize('failover.setKey.pick', "Set the API key for…"));
		if (!provider) {
			return;
		}
		const apiKey = await quickInputService.input({
			title: localize('failover.add.keyTitle', "API Key for {0}", provider),
			prompt: localize('failover.setKey.prompt', "Stored in secure storage. Empty removes the key."),
			password: true,
		});
		if (apiKey !== undefined) {
			await failoverService.setApiKey(provider, apiKey || undefined);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'hivemindide.failover.removeProvider', title: localize2('failover.remove', "Remove AI Provider…"), category: CATEGORY, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInputService = accessor.get(IQuickInputService);
		const failoverService = accessor.get(IProviderFailoverService);
		const provider = await pickProvider(quickInputService, failoverService, accessor.get(INotificationService), localize('failover.remove.pick', "Remove which provider? Its key is deleted too."));
		if (provider) {
			await failoverService.removeProvider(provider);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'hivemindide.failover.retryAll', title: localize2('failover.retryAll', "Retry All AI Providers Now"), category: CATEGORY, f1: true });
	}
	run(accessor: ServicesAccessor): void {
		const failoverService = accessor.get(IProviderFailoverService);
		const notificationService = accessor.get(INotificationService);
		const cooling = failoverService.activeCooldowns();
		failoverService.clearCooldowns();
		notificationService.info(cooling.length
			? localize('failover.retried', "The next chat request tries {0} again.", cooling.map(([name]) => name).join(', '))
			: localize('failover.nothingOnHold', "No provider was on hold."));
	}
});

async function pickProvider(quickInputService: IQuickInputService, failoverService: IProviderFailoverService, notificationService: INotificationService, placeHolder: string): Promise<string | undefined> {
	const providers = failoverService.allProviders;
	if (providers.length === 0) {
		notificationService.info(localize('failover.none', "No AI providers yet. Run HivemindIDE: Add AI Provider… first."));
		return undefined;
	}
	const pick = await quickInputService.pick(providers.map((p, i) => ({ label: p.name, description: `#${i + 1} · ${p.model}`, detail: p.url })), { placeHolder });
	return pick?.label;
}

