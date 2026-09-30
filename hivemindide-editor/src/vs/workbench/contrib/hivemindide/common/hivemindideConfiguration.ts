/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE feature configuration.
 *
 *  Every HivemindIDE feature registers its settings here and is gated on a
 *  `hivemindide.<feature>.enabled` boolean. Keeping the schema in one file means the
 *  Settings UI groups our features together, and means a new feature is a new
 *  block here rather than a new registration scattered through the tree.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions, ConfigurationScope } from '../../../../platform/configuration/common/configurationRegistry.js';

export const HIVEMINDIDE_CONFIG_SECTION = 'hivemindide';

export const enum HivemindIDESettings {
	UsageIndicatorEnabled = 'hivemindide.usageIndicator.enabled',
	UsageIndicatorShowCost = 'hivemindide.usageIndicator.showCost',
	UsageIndicatorDailyTokenBudget = 'hivemindide.usageIndicator.dailyTokenBudget',
	UsageIndicatorRefreshSeconds = 'hivemindide.usageIndicator.refreshSeconds',
	UsageNotchEnabled = 'hivemindide.usageNotch.enabled',
	UsageNotchKeepOpen = 'hivemindide.usageNotch.keepOpen',
	UsageNotchUseMacbookNotch = 'hivemindide.usageNotch.useMacbookNotch',
	UsageNotchAlertThresholds = 'hivemindide.usageNotch.alertThresholds',
	UsageNotchMutedProviders = 'hivemindide.usageNotch.mutedProviders',
	AgentTreeEnabled = 'hivemindide.agentTree.enabled',
	AgentTreeCoordinationUrl = 'hivemindide.agentTree.coordinationUrl',
	AgentTreeRepoId = 'hivemindide.agentTree.repoId',
	LocalModelsEnabled = 'hivemindide.localModels.enabled',
	LocalModelsModels = 'hivemindide.localModels.models',
	LocalModelsChatModel = 'hivemindide.localModels.chatModel',
	LocalModelsEmbeddingModel = 'hivemindide.localModels.embeddingModel',
	LocalModelsContextSize = 'hivemindide.localModels.contextSize',
	LocalModelsGpuLayers = 'hivemindide.localModels.gpuLayers',
	LocalModelsServerPath = 'hivemindide.localModels.serverPath',
	LocalModelsWorkspaceContext = 'hivemindide.localModels.workspaceContext',
	LocalModelsMaxContextChunks = 'hivemindide.localModels.maxContextChunks',
	LocalModelsModelsFolder = 'hivemindide.localModels.modelsFolder',
	LocalModelsDevices = 'hivemindide.localModels.devices',
	LocalModelsSplitMode = 'hivemindide.localModels.splitMode',
	LocalModelsMainGpu = 'hivemindide.localModels.mainGpu',
	LocalModelsTensorSplit = 'hivemindide.localModels.tensorSplit',
	LocalModelsModelArgs = 'hivemindide.localModels.modelArgs',
	LocalModelsThreads = 'hivemindide.localModels.threads',
	LocalModelsFlashAttention = 'hivemindide.localModels.flashAttention',
	LocalModelsKeepAliveMinutes = 'hivemindide.localModels.keepAliveMinutes',
	LocalModelsEndpoint = 'hivemindide.localModels.endpoint',
	LocalModelsRemoteUrl = 'hivemindide.localModels.remoteUrl',
	LocalModelsRemoteChatModel = 'hivemindide.localModels.remoteChatModel',
	LocalModelsRemoteEmbeddingModel = 'hivemindide.localModels.remoteEmbeddingModel',
	LocalModelsShareOnNetwork = 'hivemindide.localModels.shareOnNetwork',
	LocalModelsSharePort = 'hivemindide.localModels.sharePort',
	HivemindEnabled = 'hivemindide.hivemind.enabled',
	HivemindAgentPointers = 'hivemindide.hivemind.agentPointers',
	HivemindAuthor = 'hivemindide.hivemind.author',
	HivemindIncludeInChat = 'hivemindide.hivemind.includeInChat',
	FailoverMode = 'hivemindide.failover.mode',
	FailoverProviders = 'hivemindide.failover.providers',
	ShellRuntimePath = 'hivemindide.shell.runtimePath',
	ShellNodePath = 'hivemindide.shell.nodePath',
	ShellAskRouteOnSpawn = 'hivemindide.shell.askRouteOnSpawn',
	ShellUseInstalledClis = 'hivemindide.shell.useInstalledClis',
	ShellCliPermissions = 'hivemindide.shell.cliPermissions',
	ServicedCombos = 'hivemindide.serviced.combos',
	ServicedDefaultRoute = 'hivemindide.serviced.defaultRoute',
	ModelTraits = 'hivemindide.models.traits',
	ModelTaskRoutes = 'hivemindide.models.taskRoutes',
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: HIVEMINDIDE_CONFIG_SECTION,
	order: 100,
	title: localize('hivemindide.configuration.title', "HivemindIDE"),
	type: 'object',
	properties: {
		[HivemindIDESettings.UsageIndicatorEnabled]: {
			type: 'boolean',
			default: true,
			// APPLICATION scope: this reads files in your home directory, so it is
			// a property of this machine's install, not of a workspace. A repo you
			// clone must not be able to switch it on for you.
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.usageIndicator.enabled', "Show a status bar indicator with AI coding assistant token usage, read from local tool data. Turning this off removes the indicator and stops all file polling."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.UsageIndicatorShowCost]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.usageIndicator.showCost', "Include estimated cost in the usage indicator's tooltip, when the local data reports it."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.UsageIndicatorDailyTokenBudget]: {
			type: 'number',
			default: 0,
			minimum: 0,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.usageIndicator.dailyTokenBudget', "Daily token budget used to render usage as a percentage. Set to `0` to show the raw token count instead.\n\nLocal tool data does not report your plan's real limit, so this is a budget you choose, not a limit anyone enforces."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.UsageIndicatorRefreshSeconds]: {
			type: 'number',
			default: 60,
			minimum: 10,
			maximum: 3600,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.usageIndicator.refreshSeconds', "How often to re-read local usage data, in seconds."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.UsageNotchEnabled]: {
			type: 'boolean',
			default: true,
			// APPLICATION scope for the same reason as the usage indicator: it reads
			// files in your home directory.
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.usageNotch.enabled', "Show the usage notch: a pill on the window edge that opens into one ring per AI assistant, filled by how much of its plan limit is used, and alerts you as a limit nears.\n\nFigures come only from what the tools record on this machine (Codex session logs, Claude Code runs inside HivemindIDE, backup providers that ran out). Nothing is fetched and no credential is read. Turning this off removes the notch and stops all polling."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.UsageNotchKeepOpen]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.usageNotch.keepOpen', "Keep the usage notch open at all times. Turn off to fold it into a pill on the window edge until the pointer reaches it."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.UsageNotchUseMacbookNotch]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.usageNotch.useMacbookNotch', "On a MacBook with a camera notch, show the usage notch in the notch itself, outside the editor window, with the Hivemind cell, what the agents are doing, and their permission requests. Found automatically; on other Macs and screens the notch stays on the window edge."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.UsageNotchAlertThresholds]: {
			type: 'array',
			items: { type: 'number', minimum: 1, maximum: 100 },
			default: [80, 100],
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.usageNotch.alertThresholds', "Notify when a usage limit reaches each of these percentages. Each alerts once per limit window. An empty list turns alerts off; the rings still show."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.UsageNotchMutedProviders]: {
			type: 'array',
			items: { type: 'string' },
			default: [],
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.usageNotch.mutedProviders', "Assistants whose usage alerts are muted, by name as the notch shows it (for example `Codex`). Their rings still show."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.AgentTreeEnabled]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.agentTree.enabled', "Show the HivemindIDE Agents sidebar with the author+AI spawn tree."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.AgentTreeCoordinationUrl]: {
			type: 'string',
			default: 'http://127.0.0.1:8082',
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.agentTree.coordinationUrl', "Base URL of coordinationd. Used for the presence stream and live agent.spawned frames."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.AgentTreeRepoId]: {
			type: 'string',
			default: '11111111-1111-4111-8111-111111111111',
			scope: ConfigurationScope.WINDOW,
			description: localize('hivemindide.agentTree.repoId', "Repo ID passed to coordinationd for the agent tree stream. Use the seeded demo id, or your own."),
			tags: ['hivemindide']
		},
		// Local models: every setting is APPLICATION scope. They start processes
		// and read model files from disk, so a cloned repo's .vscode/settings.json
		// must never be able to point them somewhere else.
		[HivemindIDESettings.LocalModelsEnabled]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.localModels.enabled', "Run GGUF models locally with llama.cpp and use them in the Chat panel. Turning this off stops any running llama.cpp server."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsModels]: {
			type: 'array',
			items: { type: 'string' },
			default: [],
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.localModels.models', "Absolute paths of the .gguf model files available to HivemindIDE."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsChatModel]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.localModels.chatModel', "Path of the .gguf model used for chat. Empty uses the first model in the list."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsEmbeddingModel]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.localModels.embeddingModel', "Path of a .gguf embedding model (for example `nomic-embed-text`) used to search the workspace by meaning. Empty falls back to keyword search."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsContextSize]: {
			type: 'number',
			default: 8192,
			minimum: 0,
			maximum: 262144,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.localModels.contextSize', "Context window, in tokens, the chat model is started with. Larger windows use more memory. 0 lets llama.cpp choose the largest that fits in memory. If the model runs out of memory, HivemindIDE halves it automatically for that model."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsGpuLayers]: {
			type: 'number',
			default: -1,
			minimum: -1,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.localModels.gpuLayers', "Number of model layers offloaded to the GPU. -1 lets llama.cpp put as many as fit in GPU memory (recommended); 999 forces everything onto the GPU; 0 runs on the CPU only."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsServerPath]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.localModels.serverPath', "Path to a `llama-server` executable, or the folder containing it, to use instead of the one HivemindIDE installs. Empty uses the managed install, then one already on this computer (PATH, Ollama, winget, scoop, Homebrew), and installs one only if none is found."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsWorkspaceContext]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.localModels.workspaceContext', "Index the open workspace and add the most relevant code to each chat request."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsMaxContextChunks]: {
			type: 'number',
			default: 6,
			minimum: 0,
			maximum: 30,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.localModels.maxContextChunks', "Maximum number of workspace snippets added to each chat request."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsModelsFolder]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.localModels.modelsFolder', "Folder scanned for `.gguf` models; every model in it is available without adding it by hand. Empty uses `~/.hivemindide/models`."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsDevices]: {
			type: 'array',
			items: { type: 'string' },
			default: [],
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.localModels.devices', "GPUs to run models on, by llama.cpp device id (for example `CUDA0`, `MTL0`). Empty uses every available GPU."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsSplitMode]: {
			type: 'string',
			enum: ['layer', 'row', 'none'],
			enumDescriptions: [
				localize('hivemindide.localModels.splitMode.layer', "Spread layers across the GPUs. Best default for several GPUs."),
				localize('hivemindide.localModels.splitMode.row', "Split each layer's tensors across the GPUs. Can be faster on fast interconnects."),
				localize('hivemindide.localModels.splitMode.none', "Use only the main GPU."),
			],
			default: 'layer',
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.localModels.splitMode', "How a model is split when more than one GPU is used."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsMainGpu]: {
			type: 'number',
			default: 0,
			minimum: 0,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.localModels.mainGpu', "Index of the GPU used for the whole model when split mode is none, or for intermediate results when it is row."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsTensorSplit]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.localModels.tensorSplit', "Share of the model per GPU, comma-separated in device order (for example `3,1` puts three quarters on the first GPU). Empty splits by free memory."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsModelArgs]: {
			type: 'object',
			additionalProperties: { type: 'string' },
			default: {},
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.localModels.modelArgs', "Extra `llama-server` arguments per model file path, for example `-ngl 99 -c 32768 --jinja --temp 1.0`. They come last, so they override the settings above. `-m`, `--host`, `--port` and `--api-key` are ignored: HivemindIDE sets those itself."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsThreads]: {
			type: 'number',
			default: 0,
			minimum: 0,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.localModels.threads', "CPU threads used for generation. 0 lets llama.cpp decide."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsFlashAttention]: {
			type: 'string',
			enum: ['auto', 'on', 'off'],
			default: 'auto',
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.localModels.flashAttention', "Flash attention. Faster and lighter on memory where the GPU supports it."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsKeepAliveMinutes]: {
			type: 'number',
			default: 30,
			minimum: 0,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.localModels.keepAliveMinutes', "Unload a model after this many idle minutes to free memory. 0 keeps it loaded until you stop it."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsEndpoint]: {
			type: 'string',
			enum: ['local', 'remote'],
			enumDescriptions: [
				localize('hivemindide.localModels.endpoint.local', "Run models on this machine with llama.cpp."),
				localize('hivemindide.localModels.endpoint.remote', "Use an OpenAI-compatible server on another machine (llama.cpp, Ollama, LM Studio, or another HivemindIDE sharing its models)."),
			],
			default: 'local',
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.localModels.endpoint', "Where chat models run."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsRemoteUrl]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.localModels.remoteUrl', "Base URL of the remote server, for example `http://192.168.1.20:8080` (llama.cpp) or `http://192.168.1.20:11434` (Ollama). Its API key is kept in secure storage, not in settings."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsRemoteChatModel]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.localModels.remoteChatModel', "Model id on the remote server used for chat. Empty uses the first model it lists."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsRemoteEmbeddingModel]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.localModels.remoteEmbeddingModel', "Model id on the remote server used for workspace search. Empty falls back to keyword search."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsShareOnNetwork]: {
			type: 'boolean',
			default: false,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.localModels.shareOnNetwork', "Serve this machine's chat model to other computers on the network, protected by an API key. Other machines connect to it as a remote server."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.LocalModelsSharePort]: {
			type: 'number',
			default: 11435,
			minimum: 1024,
			maximum: 65535,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.localModels.sharePort', "Port the shared model listens on."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.HivemindEnabled]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize('hivemindide.hivemind.enabled', "Keep shared AI context for each project in a `.hivemind` folder, so any AI (and any teammate's AI) can pick up where the last one left off. Only trusted workspaces get one."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.HivemindAgentPointers]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.WINDOW,
			markdownDescription: localize('hivemindide.hivemind.agentPointers', "Add a short managed block to the project's `AGENTS.md` and `CLAUDE.md` (creating them if missing) so Claude Code, Codex, Cursor and Copilot read `.hivemind` first and record their work there."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.HivemindAuthor]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.hivemind.author', "Your name on hivemind nodes, so teammates can tell whose AI did what. Empty uses your account name."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.HivemindIncludeInChat]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.hivemind.includeInChat', "Give the Chat panel's AI the project notes and the latest hivemind nodes with every message."),
			tags: ['hivemindide']
		},
		// APPLICATION scope for both: switching can send the chat, and the
		// workspace code in it, to a paid cloud provider. A cloned repo must not
		// be able to turn that on.
		[HivemindIDESettings.FailoverMode]: {
			type: 'string',
			enum: ['ask', 'auto', 'off'],
			enumDescriptions: [
				localize('hivemindide.failover.mode.ask', "Ask which backup provider to continue on, or whether to stop."),
				localize('hivemindide.failover.mode.auto', "Continue on the first available backup provider without asking."),
				localize('hivemindide.failover.mode.off', "Never switch. The answer stops with the provider's error."),
			],
			default: 'ask',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.failover.mode', "What the Chat panel does when its model runs out of quota, hits a rate limit, rejects its key or is down. Switching continues the same answer on a provider from `#hivemindide.failover.providers#`, which receives the conversation and its workspace context."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.FailoverProviders]: {
			type: 'array',
			default: [],
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.failover.providers', "AI providers for chat. Their models are routes in the Chat model picker, and backups when another route runs out, tried in this order. Each is an OpenAI-compatible API: `{ \"name\": \"OpenAI\", \"url\": \"https://api.openai.com/v1\", \"model\": \"gpt-5\" }`. API keys are kept in secure storage: use **HivemindIDE: Add AI Provider…** or **Set AI Provider API Key…**."),
			items: {
				type: 'object',
				required: ['name', 'url', 'model'],
				properties: {
					name: { type: 'string', description: localize('hivemindide.failover.providers.name', "A unique name, shown when switching.") },
					url: { type: 'string', description: localize('hivemindide.failover.providers.url', "Base URL of the OpenAI-compatible API.") },
					model: { type: 'string', description: localize('hivemindide.failover.providers.model', "Model id to use on this provider.") },
					models: { type: 'array', items: { type: 'string' }, description: localize('hivemindide.failover.providers.models', "More model ids on this provider, offered as hivemind shell routes.") },
					enabled: { type: 'boolean', default: true, description: localize('hivemindide.failover.providers.enabled', "Off keeps the service and its key but takes it out of the model picker, combos' choices and failover.") },
				},
			},
			tags: ['hivemindide']
		},
		// APPLICATION scope: these run a program on this machine.
		[HivemindIDESettings.ShellRuntimePath]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.shell.runtimePath', "Folder of a built hivemind-agent. When set, every provider model in `#hivemindide.failover.providers#` appears in the Chat model picker as a **Hivemind Shell** route, and choosing one runs the chat as an agent that can read, edit and run things in the workspace."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.ShellNodePath]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.shell.nodePath', "Node 22.19 or newer to run the hivemind shell with. Empty finds one on PATH, in nvm or in Homebrew."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.ShellAskRouteOnSpawn]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.shell.askRouteOnSpawn', "When a shell chat spawns sub-agents, ask which route (provider and model) each one runs on. Off runs them all on the parent's route."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.ShellUseInstalledClis]: {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.shell.useInstalledClis', "Offer the agent CLIs installed on this machine (Claude Code, Cursor, Codex) as routes in the Chat model picker. They run headless with their own login and limits."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.ShellCliPermissions]: {
			type: 'string',
			enum: ['readOnly', 'edits', 'full'],
			enumDescriptions: [
				localize('hivemindide.shell.cliPermissions.readOnly', "Read and plan only; nothing is changed."),
				localize('hivemindide.shell.cliPermissions.edits', "Edit files in the workspace; commands that need approval are refused."),
				localize('hivemindide.shell.cliPermissions.full', "Edit files and run any command without asking."),
			],
			default: 'edits',
			scope: ConfigurationScope.APPLICATION,
			description: localize('hivemindide.shell.cliPermissions', "What an agent CLI route may do. Headless CLIs cannot ask before acting, so this is decided up front."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.ServicedCombos]: {
			type: 'array',
			default: [],
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.serviced.combos', "Named chains of routes, offered in the Chat model picker as `Combo/<name>`. The strategy picks where a turn starts; when that route fails, the turn moves to the next. Manage them in the Serviced AI tab."),
			items: {
				type: 'object',
				required: ['name', 'targets'],
				properties: {
					name: { type: 'string' },
					strategy: { type: 'string', enum: ['priority', 'round-robin', 'weighted', 'random', 'least-used', 'last-good', 'fastest'], default: 'priority' },
					targets: { type: 'array', items: { type: 'object', properties: { route: { type: 'string' }, weight: { type: 'number' } }, required: ['route'] } },
				},
			},
			tags: ['hivemindide']
		},
		[HivemindIDESettings.ServicedDefaultRoute]: {
			type: 'string',
			default: '',
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.serviced.defaultRoute', "The route new chats start on, as `provider/model`, `Combo/<name>` or `Auto/by task`. Empty uses Auto: each turn goes to the model that suits its task."),
			tags: ['hivemindide']
		},
		[HivemindIDESettings.ModelTraits]: {
			type: 'object',
			default: {},
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.models.traits', "Corrections to what HivemindIDE knows about a model, by route (`provider/model`): `reasoning`, `speed` (`low`, `medium`, `high`), `cost` (`free`, `subscription`, `low`, `medium`, `high`), `tools` (true or false) and `strengths` (tasks it is good at: `plan`, `code`, `ask`, `subagent`, `summarize`). Edit them in the Serviced AI tab."),
			additionalProperties: {
				type: 'object',
				properties: {
					reasoning: { type: 'string', enum: ['low', 'medium', 'high'] },
					speed: { type: 'string', enum: ['low', 'medium', 'high'] },
					cost: { type: 'string', enum: ['free', 'subscription', 'low', 'medium', 'high'] },
					tools: { type: 'boolean' },
					strengths: { type: 'array', items: { type: 'string', enum: ['plan', 'code', 'ask', 'subagent', 'summarize'] } },
				},
			},
			tags: ['hivemindide']
		},
		[HivemindIDESettings.ModelTaskRoutes]: {
			type: 'object',
			default: {},
			scope: ConfigurationScope.APPLICATION,
			markdownDescription: localize('hivemindide.models.taskRoutes', "Which route runs each task: `plan`, `code`, `ask`, `subagent`, `summarize`. `auto` (the default) picks the model that suits the task best among those available; a route or `Combo/<name>` pins it."),
			properties: Object.fromEntries(['plan', 'code', 'ask', 'subagent', 'summarize'].map(task => [task, { type: 'string', default: 'auto' }])),
			tags: ['hivemindide']
		}
	}
});

// Product defaults that must not edit upstream files. Same effect as changing
// ThemeSettingDefaults / telemetry defaults in microsoft/vscode, none of the
// merge cost. apply-branding.sh also flips the registered defaults for
// VSCodium parity; this is the belt that survives if a merge restores them.
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
	.registerDefaultConfigurations([{
		overrides: {
			'workbench.colorTheme': 'Hivemind Dynamic',
			'workbench.iconTheme': 'vscode-modern-icons',
			'telemetry.telemetryLevel': 'off',
			'telemetry.feedback.enabled': false,
			'telemetry.enableCrashReporter': false,
			'telemetry.editStats.enabled': false,
			'workbench.enableExperiments': false,
			'workbench.settings.enableNaturalLanguageSearch': false,
			'workbench.commandPalette.experimental.enableNaturalLanguageSearch': false,
		}
	}]);
