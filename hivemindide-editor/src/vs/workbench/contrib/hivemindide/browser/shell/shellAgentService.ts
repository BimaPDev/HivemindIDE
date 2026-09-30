/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE hivemind shell, window side: routes, sessions, permissions.
 *
 *  Every chat and every hivemind node runs in the shell, in its own runtime
 *  session keyed by whatever owns it (a chat session, a sub-agent's node). The
 *  route (provider + model) is chosen per session and can change between turns.
 *  Routes are the user's local models (served by llama.cpp here, or by their
 *  remote llama server) and the models of their AI providers. The runtime asks
 *  before its tools touch anything; this window answers for the sessions it owns.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { AsyncIterableSource, DeferredPromise } from '../../../../../base/common/async.js';
import { HivemindCliPermissions, HivemindShellEvent, HivemindShellStopReason, IHivemindCliAgent, IHivemindCliBackend, IHivemindShellPermissionRequest, IHivemindShellService, IHivemindShellSession } from '../../../../../platform/hivemindide/common/hivemindShell.js';
import { ILocalLlamaService } from '../../../../../platform/hivemindide/common/localLlama.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ChatMessageRole, IChatMessage, IChatResponsePart, ILanguageModelChatResponse } from '../../../chat/common/languageModels.js';
import { HIVEMINDIDE_CONFIG_SECTION, HivemindIDESettings } from '../../common/hivemindideConfiguration.js';
import { IFailoverProvider } from '../../common/providerFailover.js';
import { buildShellOverlay, findRoute, findRouteChoice, isLocalRoute, IShellRoute, KEYLESS_PLACEHOLDER, LOCAL_ROUTE_PROVIDER, localRoutes, RouteGroup, routeId, shellRoutes } from '../../common/shellRoutes.js';
import { localMaxOutputTokens, streamLlamaChat } from '../localModels/localLanguageModelProvider.js';
import { ILocalModelsService } from '../localModels/localModelsService.js';
import { averageMs, COMBO_PROVIDER } from '../../common/servicedRouting.js';
import { AUTO_MODEL, AUTO_PROVIDER, catalogEntry, ICatalogEntry, IRanked, rankForTask, TaskKind } from '../../common/modelCatalog.js';
import { IServicedAIService } from '../serviced/servicedAIService.js';
import { IProviderFailoverService } from '../localModels/providerFailoverService.js';

export const IShellAgentService = createDecorator<IShellAgentService>('hivemindideShellAgentService');

export interface IShellRunOptions {
	/** Who owns the session: a chat session, a node id. The same key reuses the session. */
	readonly key: string;
	/** A persisted session to resume when this key has none yet (from a node's `shellSession`). */
	readonly resume?: string;
	readonly route: IShellRoute;
	readonly text: string;
	readonly onEvent: (event: HivemindShellEvent) => void;
}

export interface IShellAgentService {
	readonly _serviceBrand: undefined;

	/** Routes changed. */
	readonly onDidChange: Event<void>;
	/** Local models first, then the installed agent CLIs', then each provider's, in the user's order. */
	readonly routes: readonly IShellRoute[];
	/** Agent CLIs found on this machine (Claude Code, Cursor, Codex), as last detected. */
	readonly cliAgents: readonly IHivemindCliAgent[];
	/** Looks for installed agent CLIs again. */
	detectCliAgents(): Promise<readonly IHivemindCliAgent[]>;
	/** The installed agent CLI a route runs on, if it is a CLI route. */
	cliAgentFor(route: IShellRoute): IHivemindCliAgent | undefined;
	/** Where a route is listed in the model picker: Hivemind (Auto, combos), Local, CLI or Service. */
	groupOf(route: IShellRoute): RouteGroup;
	/**
	 * The concrete routes a turn on `route` tries, in order. A combo gives its
	 * targets in its strategy's order (resting ones last); any other route is itself.
	 */
	plan(route: IShellRoute): IShellRoute[];

	/** Every model the user can run (local, installed CLIs, API services), with what is known about it. */
	catalog(): ICatalogEntry[];
	/** The models that can do `task`, best first, leaving out resting ones. */
	rankForTask(task: TaskKind): IRanked[];
	/** The route `task` runs on: the one pinned for it, else the best available. */
	routeForTask(task: TaskKind): IShellRoute | undefined;
	/** Where a chat runs when no route was picked: the selected local model, else the first route. */
	readonly defaultRoute: IShellRoute | undefined;
	getRoute(id: string | undefined): IShellRoute | undefined;

	/** Asks which route to run something on. `suggested` is listed first. */
	pickRoute(title: string, suggested: IShellRoute | undefined, token: CancellationToken): Promise<IShellRoute | undefined>;
	/** Runs one turn in the key's session on `route`. Returns the session id with the stop reason. */
	run(options: IShellRunOptions, token: CancellationToken): Promise<{ readonly sessionId: string; readonly stopReason: HivemindShellStopReason }>;
	/** A single completion on `route`, straight to the provider, with no agent or tools. For planning. */
	complete(route: IShellRoute, system: string, user: string, token: CancellationToken): Promise<string>;
	/** A plain streamed completion on `route`, for callers outside the shell (the model picker's API users). */
	directChat(route: IShellRoute, messages: readonly IChatMessage[], token: CancellationToken): Promise<ILanguageModelChatResponse>;
}

export class ShellAgentService extends Disposable implements IShellAgentService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	/** Key → live session, what runs it (`runtime` or a CLI's id), and the route last set on it. */
	private readonly sessions = new Map<string, { readonly info: IHivemindShellSession; readonly backend: string; route?: string }>();
	private _cliAgents: readonly IHivemindCliAgent[] = [];
	/** Key → session id that outlived a runtime restart and can be resumed. */
	private readonly resumable = new Map<string, string>();
	private readonly ownSessions = new Set<string>();

	constructor(
		@IHivemindShellService private readonly shellService: IHivemindShellService,
		@IProviderFailoverService private readonly failoverService: IProviderFailoverService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IDialogService private readonly dialogService: IDialogService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IPathService private readonly pathService: IPathService,
		@ILocalLlamaService private readonly localLlamaService: ILocalLlamaService,
		@ILocalModelsService private readonly localModelsService: ILocalModelsService,
		@IServicedAIService private readonly servicedAIService: IServicedAIService,
	) {
		super();
		this._register(this.servicedAIService.onDidChange(() => this._onDidChange.fire()));
		this._register(this.failoverService.onDidChange(() => this._onDidChange.fire()));
		this._register(this.localModelsService.onDidChangeModels(() => this._onDidChange.fire()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(HIVEMINDIDE_CONFIG_SECTION)) {
				this._onDidChange.fire();
			}
		}));
		this._register(this.shellService.onDidExit(() => {
			for (const [key, session] of this.sessions) {
				this.resumable.set(key, session.info.sessionId);
			}
			this.sessions.clear();
		}));
		this._register(this.shellService.onDidRequestPermission(request => this.onPermission(request)));
		this.detectCliAgents();
	}

	get cliAgents(): readonly IHivemindCliAgent[] {
		return this.configurationService.getValue<boolean>(HivemindIDESettings.ShellUseInstalledClis) === false ? [] : this._cliAgents;
	}

	async detectCliAgents(): Promise<readonly IHivemindCliAgent[]> {
		try {
			this._cliAgents = await this.shellService.detectCliAgents();
		} catch {
			this._cliAgents = [];
		}
		this._onDidChange.fire();
		return this.cliAgents;
	}

	cliAgentFor(route: IShellRoute): IHivemindCliAgent | undefined {
		return this.cliAgents.find(a => a.name === route.provider);
	}

	groupOf(route: IShellRoute): RouteGroup {
		return route.provider === AUTO_PROVIDER || route.provider === COMBO_PROVIDER ? 'hivemind' : isLocalRoute(route) ? 'local' : this.cliAgentFor(route) ? 'cli' : 'service';
	}

	private cliBackend(route: IShellRoute, permissions?: HivemindCliPermissions): IHivemindCliBackend | undefined {
		const agent = this.cliAgentFor(route);
		return agent && { agent: agent.id, permissions: permissions ?? this.configurationService.getValue<HivemindCliPermissions>(HivemindIDESettings.ShellCliPermissions) ?? 'edits' };
	}

	get routes(): readonly IShellRoute[] {
		const local = this.localModelsService.enabled ? localRoutes(this.localModelsService.models.map(m => m.name)) : [];
		const clis = this.cliAgents.flatMap(agent => agent.models.map(model => ({ id: routeId(agent.name, model), provider: agent.name, model })));
		// A provider named like the local models, an installed CLI or the combos would shadow their routes.
		const taken = new Set([LOCAL_ROUTE_PROVIDER, COMBO_PROVIDER, AUTO_PROVIDER, ...this.cliAgents.map(a => a.name)]);
		const combos = this.servicedAIService.combos.filter(c => c.targets.length).map(c => ({ id: routeId(COMBO_PROVIDER, c.name), provider: COMBO_PROVIDER, model: c.name }));
		const models = [...local, ...clis, ...shellRoutes(this.failoverService.providers.filter(p => !taken.has(p.name)))];
		// Auto picks per turn from the models above, so it is only offered when there are some.
		const auto = models.length ? [{ id: routeId(AUTO_PROVIDER, AUTO_MODEL), provider: AUTO_PROVIDER, model: AUTO_MODEL }] : [];
		return [...auto, ...models, ...combos];
	}

	get defaultRoute(): IShellRoute | undefined {
		const routes = this.routes;
		// Unless the user chose one, chats start on Auto: each turn goes to the model that suits it.
		return findRoute(routes, this.servicedAIService.defaultRoute) ?? routes[0];
	}

	catalog(): ICatalogEntry[] {
		const overrides = this.servicedAIService.traitOverrides;
		return this.routes.filter(r => r.provider !== AUTO_PROVIDER && r.provider !== COMBO_PROVIDER).map(route => {
			const cli = this.cliAgentFor(route);
			const stats = this.servicedAIService.stats(route.id);
			const observed = { toolless: this.servicedAIService.isToolless(route.id), averageMs: averageMs(stats), successes: stats ? stats.requests - stats.failures : 0 };
			// A CLI's own default (Claude Code's `default`, Cursor's `auto`) is whatever it recommends.
			return catalogEntry(route, isLocalRoute(route) ? 'local' : cli ? 'cli' : 'api', observed, overrides[route.id], !!cli && /^(default|auto)$/.test(route.model));
		});
	}

	rankForTask(task: TaskKind): IRanked[] {
		return rankForTask(this.catalog(), task, id => {
			const route = findRoute(this.routes, id);
			return !!route && !this.failoverService.cooldown(route.provider);
		});
	}

	routeForTask(task: TaskKind): IShellRoute | undefined {
		const pinned = findRoute(this.routes, this.servicedAIService.taskRoute(task));
		if (pinned && pinned.provider !== AUTO_PROVIDER) {
			return pinned;
		}
		const best = this.rankForTask(task)[0];
		return best && findRoute(this.routes, best.entry.route);
	}

	plan(route: IShellRoute): IShellRoute[] {
		if (route.provider === AUTO_PROVIDER) {
			// Callers that know their task resolve Auto themselves; anything else is a question.
			const chosen = this.routeForTask('ask');
			return chosen ? this.plan(chosen) : [];
		}
		if (route.provider !== COMBO_PROVIDER) {
			return [route];
		}
		const routes = this.routes.filter(r => r.provider !== COMBO_PROVIDER);
		return this.servicedAIService.planCombo(route.model, id => {
			const target = findRoute(routes, id);
			return !!target && !this.failoverService.cooldown(target.provider);
		}).map(id => findRoute(routes, id)).filter((r): r is IShellRoute => !!r);
	}

	getRoute(id: string | undefined): IShellRoute | undefined {
		return findRoute(this.routes, id);
	}

	async pickRoute(title: string, suggested: IShellRoute | undefined, token: CancellationToken): Promise<IShellRoute | undefined> {
		const routes = this.routes;
		const item = (route: IShellRoute, description?: string): IQuickPickItem & { route: IShellRoute } => ({ label: route.model, description: description ?? route.provider, route });
		const items: ((IQuickPickItem & { route: IShellRoute }) | IQuickPickSeparator)[] = suggested
			? [item(suggested, localize('shell.route.same', "{0} · same as parent", suggested.provider)), { type: 'separator' }, ...routes.filter(r => r.id !== suggested.id).map(r => item(r))]
			: routes.map(r => item(r));
		const pick = await this.quickInputService.pick(items, { title, placeHolder: localize('shell.route.placeholder', "Route: which provider and model runs this"), ignoreFocusLost: true }, token);
		return pick?.route;
	}

	async run(options: IShellRunOptions, token: CancellationToken): Promise<{ sessionId: string; stopReason: HivemindShellStopReason }> {
		const cli = this.cliBackend(options.route);
		if (!cli) {
			// A local route needs its model served before the runtime can reach it.
			const local = isLocalRoute(options.route) ? await this.localEndpoint(options.route) : undefined;
			await this.shellService.ensureStarted(await this.launch(local));
		}
		const session = await this.session(options.key, options.resume, cli);
		const sessionId = session.info.sessionId;

		if (session.route !== options.route.id) {
			const choice = findRouteChoice(session.info.routes, options.route);
			if (!choice) {
				throw new Error(localize('shell.route.missing', "The hivemind shell has no route {0}. Check hivemindide.failover.providers.", options.route.id));
			}
			if (choice !== session.info.route) {
				await this.shellService.setOption(sessionId, 'model', choice);
			}
			session.route = options.route.id;
		}

		const listener = this.shellService.onDidEvent(e => {
			if (e.sessionId === sessionId) {
				options.onEvent(e);
			}
		});
		const cancel = token.onCancellationRequested(() => this.shellService.cancel(sessionId));
		try {
			return { sessionId, stopReason: await this.shellService.prompt(sessionId, options.text) };
		} finally {
			listener.dispose();
			cancel.dispose();
		}
	}

	async complete(route: IShellRoute, system: string, user: string, token: CancellationToken): Promise<string> {
		route = this.plan(route)[0] ?? route;
		if (this.cliAgentFor(route)) {
			return this.completeOnCli(route, `${system}\n\n${user}`, token);
		}
		const messages: IChatMessage[] = [
			{ role: ChatMessageRole.System, content: [{ type: 'text', value: system }] },
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: user }] },
		];
		const response = await this.directChat(route, messages, token);
		let text = '';
		for await (const part of response.stream) {
			for (const item of Array.isArray(part) ? part : [part]) {
				if (item.type === 'text') {
					text += item.value;
				}
			}
		}
		await response.result;
		return text.trim();
	}

	async directChat(route: IShellRoute, messages: readonly IChatMessage[], token: CancellationToken): Promise<ILanguageModelChatResponse> {
		route = this.plan(route)[0] ?? route;
		if (this.cliAgentFor(route)) {
			// A CLI has no plain-completion endpoint: one read-only turn stands in for it.
			const prompt = messages.map(m => `${m.role === ChatMessageRole.System ? 'Instructions' : m.role === ChatMessageRole.Assistant ? 'Assistant' : 'User'}:\n${m.content.map(p => p.type === 'text' ? p.value : '').join('')}`).join('\n\n');
			const stream = new AsyncIterableSource<IChatResponsePart>();
			const result = new DeferredPromise<void>();
			this.completeOnCli(route, prompt, token, text => stream.emitOne({ type: 'text', value: text })).then(
				() => { stream.resolve(); result.complete(); },
				err => { stream.reject(err); result.error(err); });
			return { stream: stream.asyncIterable, result: result.p };
		}
		if (isLocalRoute(route)) {
			const model = this.localModel(route);
			const state = await this.localModelsService.ensureChatServer(model);
			const remote = await this.localModelsService.remoteFor(model);
			return streamLlamaChat(this.localLlamaService, messages, { maxTokens: localMaxOutputTokens(state.contextSize ?? this.localModelsService.contextSize), remote }, token);
		}
		const provider = this.failoverService.providers.find(p => p.name === route.provider);
		if (!provider) {
			throw new Error(localize('shell.route.missing', "The hivemind shell has no route {0}. Check hivemindide.failover.providers.", route.id));
		}
		return streamLlamaChat(this.localLlamaService, messages, { remote: { ...await this.failoverService.remoteFor(provider), model: route.model } }, token);
	}

	// ---- Internals -----------------------------------------------------------------

	/** One read-only turn on a CLI route in a throwaway session; its answer text. */
	private async completeOnCli(route: IShellRoute, prompt: string, token: CancellationToken, onText?: (text: string) => void): Promise<string> {
		const cwd = this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? (await this.pathService.userHome()).fsPath;
		const session = await this.shellService.newSession(cwd, this.cliBackend(route, 'readOnly'));
		let text = '';
		const listener = this.shellService.onDidEvent(e => {
			if (e.sessionId === session.sessionId && e.kind === 'text') {
				text += e.text;
				onText?.(e.text);
			}
		});
		const cancel = token.onCancellationRequested(() => this.shellService.cancel(session.sessionId));
		try {
			await this.shellService.setOption(session.sessionId, 'model', route.model);
			await this.shellService.prompt(session.sessionId, prompt);
			return text.trim();
		} finally {
			listener.dispose();
			cancel.dispose();
			this.shellService.closeSession(session.sessionId);
		}
	}

	private localModel(route: IShellRoute) {
		const model = this.localModelsService.models.find(m => m.name === route.model);
		if (!model) {
			throw new Error(localize('shell.local.missing', "The local model {0} is no longer available.", route.model));
		}
		return model;
	}

	/** Serves the route's local model and returns where the runtime reaches it. */
	private async localEndpoint(route: IShellRoute): Promise<{ url: string; apiKey?: string }> {
		const model = this.localModel(route);
		const remote = await this.localModelsService.remoteFor(model);
		if (remote) {
			return { url: remote.url, apiKey: remote.apiKey };
		}
		await this.localModelsService.ensureChatServer(model);
		const endpoint = await this.localLlamaService.chatEndpoint();
		if (!endpoint) {
			throw new Error(localize('shell.local.notRunning', "The local model {0} did not start.", route.model));
		}
		return endpoint;
	}

	/**
	 * `local` is the local model server a run needs now. When the run is not local,
	 * a local server that is already up stays declared, so local sessions keep working.
	 */
	private async launch(local: { url: string; apiKey?: string } | undefined) {
		local ??= this.localModelsService.enabled ? await this.localLlamaService.chatEndpoint() : undefined;
		const providers: IFailoverProvider[] = this.failoverService.providers.filter(p => p.name !== LOCAL_ROUTE_PROVIDER);
		const localModels = this.routes.filter(isLocalRoute).map(r => r.model);
		if (local && localModels.length) {
			providers.unshift({ name: LOCAL_ROUTE_PROVIDER, url: local.url, model: localModels[0], models: localModels.slice(1) });
		}
		// The default route is only where a new session starts; each run sets its own.
		// It must not follow the run's route, or every route change would restart the runtime.
		const { overlay, keyVariables } = buildShellOverlay(providers, shellRoutes(providers)[0]);
		const secrets: Record<string, string> = {};
		for (const provider of providers) {
			const key = provider.name === LOCAL_ROUTE_PROVIDER ? local?.apiKey : (await this.failoverService.remoteFor(provider)).apiKey;
			secrets[keyVariables.get(provider.name)!] = key || KEYLESS_PLACEHOLDER;
		}
		return {
			nodePath: this.configurationService.getValue<string>(HivemindIDESettings.ShellNodePath)?.trim() || undefined,
			runtimePath: this.configurationService.getValue<string>(HivemindIDESettings.ShellRuntimePath)?.trim() || undefined,
			homePath: joinPath(this.environmentService.userRoamingDataHome, '..', 'hivemind-shell').fsPath,
			overlay,
			secrets,
		};
	}

	/** The key's session on the route's backend; moving to another backend opens a new session there. */
	private async session(key: string, resume: string | undefined, cli: IHivemindCliBackend | undefined): Promise<{ readonly info: IHivemindShellSession; readonly backend: string; route?: string }> {
		const backend = cli?.agent ?? 'runtime';
		const existing = this.sessions.get(key);
		if (existing?.backend === backend) {
			return existing;
		}
		if (existing) {
			this.sessions.delete(key);
			resume = undefined;
		}
		const cwd = this.workspaceContextService.getWorkspace().folders[0]?.uri.fsPath ?? (await this.pathService.userHome()).fsPath;
		const previous = this.resumable.get(key) ?? resume;
		let info: IHivemindShellSession | undefined;
		// Only a session of the same backend can be resumed (CLI session ids say which CLI).
		const sameBackend = previous !== undefined && (cli ? previous.startsWith(`cli:${cli.agent}:`) : !previous.startsWith('cli:'));
		if (previous && sameBackend) {
			try {
				info = await this.shellService.resumeSession(previous, cwd, cli);
			} catch {
				// Gone or from another workspace: start fresh, the node's handoff still carries the context.
			}
		}
		info ??= await this.shellService.newSession(cwd, cli);
		this.resumable.delete(key);
		const session = { info, backend };
		this.sessions.set(key, session);
		this.ownSessions.add(info.sessionId);
		return session;
	}

	private async onPermission(request: IHivemindShellPermissionRequest): Promise<void> {
		if (!this.ownSessions.has(request.sessionId)) {
			return; // another window's session
		}
		const allow = request.options.filter(o => o.kind.startsWith('allow'));
		// Answered elsewhere (the MacBook notch): take the dialog down rather than leave it asking.
		const answered = new CancellationTokenSource();
		let answeredElsewhere = false;
		const listener = this.shellService.onDidResolvePermission(id => {
			if (id === request.id) {
				answeredElsewhere = true;
				answered.cancel();
			}
		});
		const { result } = await this.dialogService.prompt<string | undefined>({
			// Only the custom dialog can be taken down from code; a native one ignores the token.
			custom: true,
			token: answered.token,
			type: 'info',
			message: localize('shell.permission', "The hivemind agent wants to use {0}.", request.title),
			detail: localize('shell.permission.detail', "It runs in this workspace. Decline and the agent is told it was not allowed."),
			buttons: allow.map(o => ({ label: o.name, run: () => o.optionId })),
			cancelButton: { label: localize('shell.permission.decline', "Decline"), run: () => request.options.find(o => o.kind === 'reject_once')?.optionId },
		}).finally(() => {
			listener.dispose();
			answered.dispose();
		});
		if (!answeredElsewhere) {
			await this.shellService.respondPermission(request.id, result);
		}
	}
}
