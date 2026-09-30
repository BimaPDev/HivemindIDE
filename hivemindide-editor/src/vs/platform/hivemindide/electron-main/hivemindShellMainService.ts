/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE hivemind shell: the runtime process and its ACP connection.
 *
 *  One hivemind-agent process serves every window; sessions are multiplexed
 *  over its stdio. Messages are newline-delimited JSON-RPC 2.0, as ACP
 *  specifies. Stdout carries only protocol traffic; stderr is kept for the
 *  log and for explaining a failed start.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { Emitter } from '../../../base/common/event.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { delimiter, join } from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { IEnvironmentMainService } from '../../environment/electron-main/environmentMainService.js';
import { ILogService } from '../../log/common/log.js';
import { HivemindCliPermissions, HivemindShellEvent, HivemindShellStopReason, IHivemindCliAgent, IHivemindCliBackend, IHivemindShellChoice, IHivemindShellLaunch, IHivemindShellPermissionRequest, IHivemindShellService, IHivemindShellSession } from '../common/hivemindShell.js';
import { accountHome, agentEnvironment, cliAgentSpec, detectCliAgents, runCliTurn } from './cliAgents.js';

const PROTOCOL_VERSION = 1;
/** Entry point and profile of a built hivemind-agent checkout. */
const RUNTIME_ENTRY = ['apps', 'cli', 'lib', 'bin.js'];
const RUNTIME_PROFILE = 'acp';
const RUNTIME_HOME_ENV = 'HIVE_HOME';
const MIN_NODE: [number, number] = [22, 19];
const START_TIMEOUT_MS = 60_000;
const STDERR_TAIL_CHARS = 4000;

interface IPending {
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: Error) => void;
}

interface IRuntime {
	readonly process: ChildProcess;
	readonly fingerprint: string;
	readonly pending: Map<number, IPending>;
	nextId: number;
	stderr: string;
	exited: boolean;
}

/** A session on an agent CLI: one CLI process per turn, resumed by the CLI's own session id. */
interface ICliSession {
	readonly agent: IHivemindCliAgent;
	readonly permissions: HivemindCliPermissions;
	readonly cwd: string;
	model: string;
	/** The CLI's session id, once known (or chosen in advance, for CLIs that allow it). */
	session?: string;
	/** A turn has run, so the next one resumes. */
	started: boolean;
	child?: ChildProcess;
}

const CLI_SESSION_PREFIX = 'cli:';

interface IAcpConfigOption {
	readonly id: string;
	readonly type?: string;
	readonly currentValue?: string;
	/** Flat choices, or groups of them (`group` set). */
	readonly options?: readonly { readonly value?: string; readonly name: string; readonly group?: string; readonly options?: readonly { readonly value: string; readonly name: string }[] }[];
}

export class HivemindShellMainService extends Disposable implements IHivemindShellService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidEvent = this._register(new Emitter<HivemindShellEvent>());
	readonly onDidEvent = this._onDidEvent.event;

	private readonly _onDidRequestPermission = this._register(new Emitter<IHivemindShellPermissionRequest>());
	readonly onDidRequestPermission = this._onDidRequestPermission.event;

	private readonly _onDidResolvePermission = this._register(new Emitter<string>());
	readonly onDidResolvePermission = this._onDidResolvePermission.event;

	private readonly _onDidExit = this._register(new Emitter<string>());
	readonly onDidExit = this._onDidExit.event;

	private runtime: IRuntime | undefined;
	private starting: Promise<IRuntime> | undefined;
	/** Prompts in flight: a runtime is only restarted when this is empty. */
	private readonly activePrompts = new Set<string>();
	/** Permission requests from the runtime, by the id handed to windows. */
	private readonly permissionRequests = new Map<string, { readonly runtime: IRuntime; readonly rpcId: number | string; readonly sessionId: string }>();
	private readonly cliSessions = new Map<string, ICliSession>();
	private cliAgents: Promise<IHivemindCliAgent[]> | undefined;
	/** Runtime sessions' current route: the runtime's opaque `["provider","model"]` value. */
	private readonly sessionRoutes = new Map<string, string>();
	/** The running launch's providers, by name, with their API base URL. */
	private providerUrls = new Map<string, string>();

	constructor(
		@ILogService private readonly logService: ILogService,
		@IEnvironmentMainService private readonly environmentMainService: IEnvironmentMainService,
	) {
		super();
	}

	override dispose(): void {
		this.kill(this.runtime);
		for (const session of this.cliSessions.values()) {
			session.child?.kill();
		}
		super.dispose();
	}

	// ---- Lifecycle ---------------------------------------------------------------

	async ensureStarted(launch: IHivemindShellLaunch): Promise<void> {
		const fingerprint = JSON.stringify([launch.nodePath ?? '', launch.runtimePath, launch.homePath, launch.overlay, Object.entries(launch.secrets).sort()]);
		if (this.runtime && !this.runtime.exited && (this.runtime.fingerprint === fingerprint || this.activePrompts.size > 0)) {
			// A changed launch waits until nothing is running; the next call applies it.
			return;
		}
		if (this.starting) {
			await this.starting;
			return this.ensureStarted(launch);
		}
		this.kill(this.runtime);
		this.providerUrls = providerUrlsOf(launch.overlay);
		this.starting = this.start(launch, fingerprint);
		try {
			this.runtime = await this.starting;
		} finally {
			this.starting = undefined;
		}
	}

	private async start(launch: IHivemindShellLaunch, fingerprint: string): Promise<IRuntime> {
		const node = await this.resolveNode(launch.nodePath);
		const entry = await this.resolveRuntime(launch.runtimePath);
		await fs.mkdir(launch.homePath, { recursive: true });
		// JSON is YAML, which is what the runtime reads overlays as.
		const overlayFile = join(launch.homePath, 'hivemindide.overlay.json');
		await fs.writeFile(overlayFile, JSON.stringify(launch.overlay, null, 2));

		// Inherited from the editor, Electron's and VS Code's variables would make the child something
		// other than plain Node, and an agent session's would tie it to that session.
		const env = agentEnvironment();
		Object.assign(env, launch.secrets, { [RUNTIME_HOME_ENV]: launch.homePath });

		this.logService.info(`[HivemindShell] starting ${node} ${entry} --profile ${RUNTIME_PROFILE}`);
		const child = spawn(node, [entry, '--profile', RUNTIME_PROFILE, '--patch', overlayFile], { cwd: launch.homePath, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
		const runtime: IRuntime = { process: child, fingerprint, pending: new Map(), nextId: 1, stderr: '', exited: false };

		let buffer = '';
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			buffer += chunk;
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line) {
					this.onMessage(runtime, line);
				}
			}
		});
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => {
			runtime.stderr = (runtime.stderr + chunk).slice(-STDERR_TAIL_CHARS);
			this.logService.trace(`[HivemindShell] ${chunk.trimEnd()}`);
		});
		const onGone = (reason: string) => {
			if (runtime.exited) {
				return;
			}
			runtime.exited = true;
			const error = new Error(`The hivemind shell stopped (${reason}).${runtime.stderr ? `\n${runtime.stderr.trim().split('\n').slice(-8).join('\n')}` : ''}`);
			for (const pending of runtime.pending.values()) {
				pending.reject(error);
			}
			runtime.pending.clear();
			// Nobody is left to hear the answers: take the questions down everywhere.
			this.cancelPermissions(request => request.runtime === runtime);
			if (this.runtime === runtime) {
				this.runtime = undefined;
				this.activePrompts.clear();
				this._onDidExit.fire(error.message);
			}
			this.logService.info(`[HivemindShell] ${error.message}`);
		};
		child.on('exit', (code, signal) => onGone(signal ? `signal ${signal}` : `exit code ${code}`));
		child.on('error', err => onGone(err.message));

		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.call(runtime, 'initialize', { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {}, clientInfo: { name: 'hivemindide', version: '1' } }),
				new Promise((_, reject) => timer = setTimeout(() => reject(new Error('The hivemind shell did not start within 60 seconds.')), START_TIMEOUT_MS)),
			]);
		} catch (err) {
			this.kill(runtime);
			throw err;
		} finally {
			clearTimeout(timer);
		}
		return runtime;
	}

	async stop(): Promise<void> {
		this.kill(this.runtime);
		this.runtime = undefined;
	}

	private kill(runtime: IRuntime | undefined): void {
		if (runtime && !runtime.exited) {
			runtime.process.kill();
		}
	}

	/**
	 * The runtime's entry point: an explicit folder, else a built hivemind-agent
	 * beside the editor checkout (where fork/rebrand-agent.mjs puts it), else one
	 * shipped in the application's resources.
	 */
	private async resolveRuntime(configured: string | undefined): Promise<string> {
		const appRoot = this.environmentMainService.appRoot;
		const folders = configured?.trim()
			? [configured.trim()]
			: [join(appRoot, '..', 'hivemind-agent'), join(appRoot, '..', '..', 'hivemind-agent'), join(appRoot, 'resources', 'hivemind-agent')];
		for (const folder of folders) {
			const entry = join(folder, ...RUNTIME_ENTRY);
			try {
				await fs.access(entry);
				return entry;
			} catch {
				// next
			}
		}
		throw new Error(configured?.trim()
			? `No built hivemind-agent at ${configured} (missing ${RUNTIME_ENTRY.join('/')}).`
			: `No built hivemind-agent found beside the editor (looked in ${folders.join(', ')}). Build it with fork/rebrand-agent.mjs, or set hivemindide.shell.runtimePath.`);
	}

	/** An explicit path, or the newest Node that is new enough in the usual places. */
	private async resolveNode(configured: string | undefined): Promise<string> {
		if (configured?.trim()) {
			const version = await nodeVersion(configured.trim());
			if (!version || !isNewEnough(version)) {
				throw new Error(`hivemindide.shell.nodePath (${configured}) is ${version ? `Node ${version.join('.')}` : 'not a working Node'}; the hivemind shell needs Node ${MIN_NODE.join('.')} or newer.`);
			}
			return configured.trim();
		}
		const exe = isWindows ? 'node.exe' : 'node';
		const candidates = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map(dir => join(dir, exe));
		const nvm = join(accountHome(), '.nvm', 'versions', 'node');
		try {
			for (const version of await fs.readdir(nvm)) {
				candidates.push(join(nvm, version, 'bin', exe));
			}
		} catch {
			// no nvm
		}
		candidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node');

		let best: { path: string; version: number[] } | undefined;
		for (const path of new Set(candidates)) {
			const version = await nodeVersion(path);
			if (version && isNewEnough(version) && (!best || compareVersions(version, best.version) > 0)) {
				best = { path, version };
			}
		}
		if (!best) {
			throw new Error(`The hivemind shell needs Node ${MIN_NODE.join('.')} or newer, and none was found. Install it, or set hivemindide.shell.nodePath.`);
		}
		return best.path;
	}

	// ---- JSON-RPC ------------------------------------------------------------------

	private async connection(): Promise<IRuntime> {
		if (this.starting) {
			await this.starting;
		}
		if (!this.runtime || this.runtime.exited) {
			throw new Error('The hivemind shell is not running.');
		}
		return this.runtime;
	}

	private call<T>(runtime: IRuntime, method: string, params: object): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			if (runtime.exited) {
				reject(new Error('The hivemind shell is not running.'));
				return;
			}
			const id = runtime.nextId++;
			runtime.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.send(runtime, { jsonrpc: '2.0', id, method, params });
		});
	}

	private send(runtime: IRuntime, message: object): void {
		runtime.process.stdin?.write(`${JSON.stringify(message)}\n`);
	}

	private onMessage(runtime: IRuntime, line: string): void {
		let message: { id?: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string; data?: unknown } };
		try {
			message = JSON.parse(line);
		} catch {
			this.logService.warn(`[HivemindShell] not JSON on stdout: ${line.slice(0, 200)}`);
			return;
		}

		if (message.method === undefined && message.id !== undefined) {
			const pending = runtime.pending.get(message.id as number);
			if (pending) {
				runtime.pending.delete(message.id as number);
				if (message.error) {
					// Keep the details: they carry the provider's status, which failover classifies.
					const data = message.error.data === undefined ? '' : ` ${typeof message.error.data === 'string' ? message.error.data : JSON.stringify(message.error.data)}`;
					pending.reject(new Error(`${message.error.message ?? 'The hivemind shell reported an error.'}${data}`));
				} else {
					pending.resolve(message.result);
				}
			}
			return;
		}

		if (message.method === 'session/update' && message.params) {
			this.onUpdate(message.params);
		} else if (message.method === 'session/request_permission' && message.id !== undefined && message.params) {
			const id = generateUuid();
			const params = message.params as { sessionId: string; toolCall?: { title?: string; name?: string }; options?: IHivemindShellPermissionRequest['options'] };
			this.permissionRequests.set(id, { runtime, rpcId: message.id, sessionId: params.sessionId });
			this._onDidRequestPermission.fire({
				id,
				sessionId: params.sessionId,
				title: params.toolCall?.title ?? params.toolCall?.name ?? 'a tool',
				options: params.options ?? [],
			});
		} else if (message.id !== undefined && message.method) {
			// Client-side capabilities we did not advertise: files, terminals.
			this.send(runtime, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `${message.method} is not supported by HivemindIDE` } });
		}
	}

	private onUpdate(params: Record<string, unknown>): void {
		const sessionId = params.sessionId as string;
		const update = params.update as { sessionUpdate?: string; content?: { type?: string; text?: string }; toolCallId?: string; title?: string; status?: string; used?: number; size?: number } | undefined;
		switch (update?.sessionUpdate) {
			case 'agent_message_chunk':
			case 'agent_thought_chunk':
				if (update.content?.type === 'text' && update.content.text) {
					this._onDidEvent.fire({ sessionId, kind: update.sessionUpdate === 'agent_message_chunk' ? 'text' : 'thought', text: update.content.text });
				}
				break;
			case 'tool_call':
			case 'tool_call_update':
				if (update.toolCallId) {
					this._onDidEvent.fire({ sessionId, kind: 'tool', toolCallId: update.toolCallId, title: update.title ?? undefined, status: update.status as 'pending' | 'in_progress' | 'completed' | 'failed' | undefined });
				}
				break;
			case 'usage_update':
				if (typeof update.used === 'number' && typeof update.size === 'number') {
					this._onDidEvent.fire({ sessionId, kind: 'usage', used: update.used, size: update.size });
				}
				break;
		}
	}

	// ---- Agent CLIs -------------------------------------------------------------------

	detectCliAgents(): Promise<IHivemindCliAgent[]> {
		this.cliAgents = detectCliAgents();
		return this.cliAgents;
	}

	private async cliAgent(id: string): Promise<IHivemindCliAgent> {
		const agent = (await (this.cliAgents ?? this.detectCliAgents())).find(a => a.id === id)
			?? (await this.detectCliAgents()).find(a => a.id === id);
		if (!agent) {
			throw new Error(`The ${cliAgentSpec(id)?.name ?? id} CLI is not installed on this machine any more.`);
		}
		return agent;
	}

	/**
	 * `id` is `cli:<agent>:<uuid>`. A CLI that takes a preset session id gets the uuid,
	 * so the same id resumes it after a restart (`resume`); the others start over.
	 */
	private async openCliSession(id: string, cwd: string, cli: IHivemindCliBackend, resume: boolean): Promise<IHivemindShellSession> {
		const agent = await this.cliAgent(cli.agent);
		const preset = !!cliAgentSpec(agent.id)?.presetSession;
		this.cliSessions.set(id, { agent, permissions: cli.permissions, cwd, model: agent.models[0] ?? 'default', session: preset ? id.split(':')[2] : undefined, started: preset && resume });
		return this.toCliSession(id);
	}

	private toCliSession(id: string): IHivemindShellSession {
		const session = this.cliSessions.get(id)!;
		return { sessionId: id, routes: session.agent.models.map(m => ({ value: m, name: m, group: session.agent.name })), route: session.model, efforts: [] };
	}

	private async promptCli(id: string, session: ICliSession, text: string): Promise<HivemindShellStopReason> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await this.promptCliOnce(id, session, text);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				if (attempt > 0 || !cliAgentSpec(session.agent.id)?.presetSession) {
					throw err;
				}
				if (!session.started && /already in use/i.test(message)) {
					// A first turn that failed still claimed the id: the session exists, so resume it.
					session.started = true;
				} else if (session.started && /no conversation found/i.test(message)) {
					// Claimed but never written (it failed before its first message): start it afresh.
					session.session = generateUuid();
					session.started = false;
				} else {
					throw err;
				}
			}
		}
	}

	private async promptCliOnce(id: string, session: ICliSession, text: string): Promise<HivemindShellStopReason> {
		let wrote = false;
		const result = await runCliTurn(session.agent, { prompt: text, cwd: session.cwd, model: session.model, permissions: session.permissions, session: session.session, resume: session.started }, event => {
			if (event.kind === 'text') {
				// Separate messages arrive whole; keep them apart as paragraphs.
				this._onDidEvent.fire({ sessionId: id, kind: 'text', text: wrote ? `\n\n${event.text}` : event.text });
				wrote = true;
			} else if (event.kind === 'thought') {
				this._onDidEvent.fire({ sessionId: id, kind: 'thought', text: event.text });
			} else if (event.kind === 'tool') {
				this._onDidEvent.fire({ sessionId: id, kind: 'tool', toolCallId: event.id, title: event.title, status: event.status });
			} else if (event.kind === 'limit') {
				// Every window hears it: the usage notch shows plan limits, not one session's.
				this._onDidEvent.fire({ sessionId: id, kind: 'limit', agent: session.agent.id, rejected: event.rejected, limitType: event.limitType, resetsAt: event.resetsAt, utilization: event.utilization });
			}
		}, child => session.child = child);
		session.child = undefined;
		session.session = result.session ?? session.session;
		session.started = true;
		return result.stopReason;
	}

	// ---- Sessions ------------------------------------------------------------------

	async newSession(cwd: string, cli?: IHivemindCliBackend): Promise<IHivemindShellSession> {
		if (cli) {
			return this.openCliSession(`${CLI_SESSION_PREFIX}${cli.agent}:${generateUuid()}`, cwd, cli, false);
		}
		const runtime = await this.connection();
		const result = await this.call<{ sessionId: string; configOptions?: IAcpConfigOption[] }>(runtime, 'session/new', { cwd, mcpServers: [] });
		return this.remember(toSession(result.sessionId, result.configOptions));
	}

	private remember(session: IHivemindShellSession): IHivemindShellSession {
		if (session.route) {
			this.sessionRoutes.set(session.sessionId, session.route);
		}
		return session;
	}

	/** What a turn on `sessionId` runs on, for the `start` event. */
	private routeOf(sessionId: string): { provider?: string; model?: string; local?: boolean; endpoint?: string } {
		const cli = this.cliSessions.get(sessionId);
		if (cli) {
			return { provider: cli.agent.name, model: cli.model === 'default' ? undefined : cli.model, local: false };
		}
		try {
			const [provider, model] = JSON.parse(this.sessionRoutes.get(sessionId) ?? '');
			if (typeof provider === 'string' && typeof model === 'string') {
				const endpoint = this.providerUrls.get(provider);
				return { provider, model, local: provider === 'Local' || isLoopbackUrl(endpoint), endpoint };
			}
		} catch {
			// not the JSON encoding, or no route known
		}
		return {};
	}

	async resumeSession(sessionId: string, cwd: string, cli?: IHivemindCliBackend): Promise<IHivemindShellSession> {
		if (sessionId.startsWith(CLI_SESSION_PREFIX)) {
			if (this.cliSessions.has(sessionId)) {
				return this.toCliSession(sessionId);
			}
			return this.openCliSession(sessionId, cwd, cli ?? { agent: sessionId.split(':')[1], permissions: 'edits' }, true);
		}
		const runtime = await this.connection();
		const result = await this.call<{ configOptions?: IAcpConfigOption[] }>(runtime, 'session/resume', { sessionId, cwd, mcpServers: [] });
		return this.remember(toSession(sessionId, result?.configOptions));
	}

	async setOption(sessionId: string, configId: string, value: string): Promise<IHivemindShellSession> {
		const cliSession = this.cliSessions.get(sessionId);
		if (cliSession) {
			if (configId === 'model') {
				cliSession.model = value;
			}
			return this.toCliSession(sessionId);
		}
		const runtime = await this.connection();
		const result = await this.call<{ configOptions?: IAcpConfigOption[] }>(runtime, 'session/set_config_option', { sessionId, configId, value });
		return this.remember(toSession(sessionId, result?.configOptions));
	}

	async prompt(sessionId: string, text: string): Promise<HivemindShellStopReason> {
		// Before the model answers: a local model can spend seconds loading with nothing to report.
		this._onDidEvent.fire({ sessionId, kind: 'start', ...this.routeOf(sessionId) });
		try {
			const cliSession = this.cliSessions.get(sessionId);
			if (cliSession) {
				return await this.promptCli(sessionId, cliSession, text);
			}
			const runtime = await this.connection();
			this.activePrompts.add(sessionId);
			try {
				const result = await this.call<{ stopReason: HivemindShellStopReason }>(runtime, 'session/prompt', { sessionId, prompt: [{ type: 'text', text }] });
				return result.stopReason;
			} finally {
				this.activePrompts.delete(sessionId);
			}
		} finally {
			// Finished, failed or cancelled: a long silent tool call is not the end, this is.
			this._onDidEvent.fire({ sessionId, kind: 'end' });
		}
	}

	async cancel(sessionId: string): Promise<void> {
		const cliSession = this.cliSessions.get(sessionId);
		if (cliSession) {
			cliSession.child?.kill();
			return;
		}
		const runtime = this.runtime;
		if (runtime && !runtime.exited) {
			// A notification: the prompt itself settles with stopReason "cancelled".
			this.send(runtime, { jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
		}
		// ACP: on cancel the client answers every pending permission request "cancelled".
		this.cancelPermissions(request => request.sessionId === sessionId);
	}

	async closeSession(sessionId: string): Promise<void> {
		const cliSession = this.cliSessions.get(sessionId);
		if (cliSession) {
			cliSession.child?.kill();
			this.cliSessions.delete(sessionId);
			return;
		}
		this.cancelPermissions(request => request.sessionId === sessionId);
		const runtime = this.runtime;
		if (runtime && !runtime.exited) {
			await this.call(runtime, 'session/close', { sessionId });
		}
	}

	async announce(event: HivemindShellEvent): Promise<void> {
		// Only the turn's bounds: a window cannot speak for a session's tools or permissions.
		if (event.kind === 'start' || event.kind === 'end') {
			this._onDidEvent.fire(event);
		}
	}

	/** Answers "cancelled" to the requests `match` picks, and tells every window and the notch they are gone. */
	private cancelPermissions(match: (request: { readonly runtime: IRuntime; readonly sessionId: string }) => boolean): void {
		for (const [id, request] of [...this.permissionRequests]) {
			if (match(request)) {
				this.respondPermission(id, undefined);
			}
		}
	}

	async respondPermission(id: string, optionId: string | undefined): Promise<void> {
		const request = this.permissionRequests.get(id);
		if (!request) {
			return; // another window answered first
		}
		this.permissionRequests.delete(id);
		if (!request.runtime.exited) {
			this.send(request.runtime, { jsonrpc: '2.0', id: request.rpcId, result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } } });
		}
		this._onDidResolvePermission.fire(id);
	}
}

/** The providers in a launch overlay, by name, with their API base URL. */
function providerUrlsOf(overlay: readonly object[]): Map<string, string> {
	const urls = new Map<string, string>();
	for (const entry of overlay as readonly { id?: string; config?: { providers?: Record<string, { baseURL?: string }> } }[]) {
		for (const [name, provider] of Object.entries(entry?.id === 'llm-pi-ai' ? entry.config?.providers ?? {} : {})) {
			if (typeof provider?.baseURL === 'string') {
				urls.set(name, provider.baseURL);
			}
		}
	}
	return urls;
}

/** A provider on this machine (Ollama, LM Studio…): its URL points at a loopback address. */
function isLoopbackUrl(url: string | undefined): boolean {
	try {
		const host = new URL(url ?? '').hostname;
		return host === 'localhost' || host === '[::1]' || host === '::1' || host.startsWith('127.');
	} catch {
		return false;
	}
}

function toSession(sessionId: string, options: readonly IAcpConfigOption[] | undefined): IHivemindShellSession {
	const select = (id: string) => options?.find(o => o.id === id && (o.type === undefined || o.type === 'select'));
	const choices = (option: IAcpConfigOption | undefined): IHivemindShellChoice[] => (option?.options ?? []).flatMap(o =>
		o.group !== undefined ? (o.options ?? []).map(c => ({ value: c.value, name: c.name, group: o.name })) : o.value !== undefined ? [{ value: o.value, name: o.name }] : []);
	const model = select('model');
	const effort = select('reasoning_effort');
	return { sessionId, routes: choices(model), route: model?.currentValue, efforts: choices(effort), effort: effort?.currentValue };
}

function nodeVersion(path: string): Promise<number[] | undefined> {
	return new Promise(resolve => {
		execFile(path, ['--version'], { timeout: 5000, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined } }, (err, stdout) => {
			const match = !err && /^v(?<major>\d+)\.(?<minor>\d+)\.(?<patch>\d+)/.exec(stdout.trim());
			resolve(match && match.groups ? [Number(match.groups.major), Number(match.groups.minor), Number(match.groups.patch)] : undefined);
		});
	});
}

function isNewEnough(version: number[]): boolean {
	return compareVersions(version, MIN_NODE) >= 0;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d !== 0) {
			return d;
		}
	}
	return 0;
}
