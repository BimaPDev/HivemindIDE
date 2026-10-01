/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE: the Chat panel's agent.
 *
 *  Every chat is a hivemind node that runs as an agent in the hivemind shell,
 *  on the route (provider + model) picked in the model picker: one of the
 *  user's local models, or a model of one of their AI providers. The agent has
 *  its own tools and works in the workspace; this class hands it the hivemind
 *  context, streams its work into the chat, and records every turn on the node.
 *
 *  A request that asks to spawn sub-agents plans the tasks, lets the user route
 *  each one, and runs each as its own node and shell session. When a route's
 *  provider runs out, the user's failover mode decides whether the session
 *  moves to a backup route and carries on.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { isLocation, Location } from '../../../../../editor/common/languages.js';
import { localize } from '../../../../../nls.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { HivemindShellEvent, IHivemindShellService } from '../../../../../platform/hivemindide/common/hivemindShell.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IChatProgress } from '../../../chat/common/chatService/chatService.js';
import { ChatMessageRole, IChatMessage } from '../../../chat/common/languageModels.js';
import { IChatAgentHistoryEntry, IChatAgentImplementation, IChatAgentRequest, IChatAgentResult } from '../../../chat/common/participants/chatAgents.js';
import { HivemindIDESettings } from '../../common/hivemindideConfiguration.js';
import { classifyProviderError, describeFailure, IProviderFailure, isFailoverReason, isToolSupportError } from '../../common/providerFailover.js';
import { IShellRoute, LOCAL_ROUTE_PROVIDER, routeId, routeIdFromModelIdentifier } from '../../common/shellRoutes.js';
import { HivemindService, IHivemindNode, IHivemindService } from '../hivemind/hivemindService.js';
import { IProviderFailoverService } from '../localModels/providerFailoverService.js';
import { IShellAgentService } from './shellAgentService.js';
import { COMBO_PROVIDER } from '../../common/servicedRouting.js';
import { AUTO_PROVIDER, parseTaskLabel, TaskKind, taskForMode } from '../../common/modelCatalog.js';
import { IServicedAIService } from '../serviced/servicedAIService.js';

export const HIVEMIND_CHAT_AGENT_ID = 'hivemindide.hivemind';
export const ADD_PROVIDER_COMMAND_ID = 'hivemindide.failover.addProvider';
export const ADD_LOCAL_MODEL_COMMAND_ID = 'hivemindide.localModels.addModel';

const MAX_ATTACHMENT_CHARS = 60_000;
/** Automatically attached instruction files (AGENTS.md, CLAUDE.md, …) are capped so they cannot crowd out the question. */
const MAX_AUTOMATIC_CHARS = 2000;
const MAX_SUBAGENTS = 4;
/** Asks the planner for independent tasks, each labelled with its kind so it can go to a model that suits it. */
const SPLIT_PROMPT = [
	'Split the request into 2 to 4 independent tasks. Reply with one task per line, each line starting with "- " and then a label for the kind of work:',
	'[plan] designing an approach, [code] writing or changing code, [research] reading and finding out, [review] checking work, [summarize] writing a summary or docs.',
	'Example: "- [research] Find where sessions are persisted". No other text.',
].join('\n');
const SHELL_AGENT_NAME = 'Hivemind Shell';
/** Room for attachments and hivemind context in a prompt; the agent reads the rest itself. */
const SHELL_CONTEXT_CHARS = 60_000;
const SHELL_RESUME_PROMPT = 'Your previous reply was cut off because its model provider failed. Continue exactly where you stopped.';
/** For a backend that has not seen the turn: the request again, and what the previous one wrote. */
const SHELL_HANDOFF_NOTE = 'Another agent started on this request and was cut off when its model provider failed. Carry on from where it stopped; do not repeat what it already did. What it had written:';
const MAX_CONTINUED_NODE_CHARS = 6000;
const MAX_HIVEMIND_CONTEXT_CHARS = 2500;
/** Earlier turns replayed to a model answering without tools (the shell session keeps its own). */
const TOOLLESS_HISTORY_CHARS = 12_000;
const TOOLLESS_SYSTEM_PROMPT = [
	'You are HivemindIDE\'s coding assistant. Answer in Markdown and keep answers focused. Put code in fenced blocks with a language tag.',
	'You cannot read, edit or run anything yourself: work from the <context> blocks you are given, and say so when you need to see code you have not been shown.',
].join('\n');

/** A provider on this machine (Ollama, LM Studio…): its URL points at a loopback address. */
function isLoopbackUrl(url: string | undefined): boolean {
	try {
		const host = new URL(url ?? '').hostname;
		return host === 'localhost' || host === '[::1]' || host === '::1' || host.startsWith('127.');
	} catch {
		return false;
	}
}

interface IContextBlock {
	readonly label: string;
	readonly text: string;
	/** Added by the chat UI rather than by the user. */
	readonly automatic?: boolean;
}

export class HivemindChatAgent extends Disposable implements IChatAgentImplementation {

	/** Chat sessions whose shell session already has the hivemind context. */
	private readonly primedShellSessions = new Set<string>();

	constructor(
		@IShellAgentService private readonly shellAgentService: IShellAgentService,
		@IServicedAIService private readonly servicedAIService: IServicedAIService,
		@IProviderFailoverService private readonly failoverService: IProviderFailoverService,
		@IHivemindService private readonly hivemindService: IHivemindService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@ILabelService private readonly labelService: ILabelService,
		@ILogService private readonly logService: ILogService,
		@IHivemindShellService private readonly shellService: IHivemindShellService,
	) {
		super();
	}

	/**
	 * One chat turn in the hivemind shell, on the picked route. The chat's node owns
	 * a shell session; its first turn there carries the hivemind context (project
	 * notes, recent nodes, a continued node), later turns only what the user attached.
	 */
	async invoke(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, history: IChatAgentHistoryEntry[], token: CancellationToken): Promise<IChatAgentResult> {
		let route = this.shellAgentService.getRoute(routeIdFromModelIdentifier(request.userSelectedModelId)) ?? this.shellAgentService.defaultRoute;
		if (route?.provider === AUTO_PROVIDER) {
			// Auto: the chat's mode says what this turn is, and the catalog which model suits it.
			const task = taskForMode(request.modeInstructions?.name);
			route = this.shellAgentService.routeForTask(task);
			if (route) {
				progress([{ kind: 'progressMessage', content: new MarkdownString(localize('hivemindChat.autoRoute', "{0}: running on {1}", taskLabel(task), route.id)) }]);
			}
		}
		if (!route) {
			progress([{
				kind: 'markdownContent',
				content: new MarkdownString(localize('hivemindChat.noRoute', "No model to run on yet. [Add a local model]({0}) to run on this machine, or [add an AI provider]({1}) such as OpenAI, Anthropic or OpenRouter.", `command:${ADD_LOCAL_MODEL_COMMAND_ID}`, `command:${ADD_PROVIDER_COMMAND_ID}`), { isTrusted: { enabledCommands: [ADD_LOCAL_MODEL_COMMAND_ID, ADD_PROVIDER_COMMAND_ID] } }),
			}]);
			return {};
		}

		// An agent CLI's own commands (/login, /model, ...) cannot run headless: it would get them as a prompt.
		const cli = this.shellAgentService.cliAgentFor(route);
		if (cli && /^\s*\/(login|logout)\b/i.test(request.message)) {
			progress([{ kind: 'markdownContent', content: new MarkdownString(localize('hivemindChat.cliLogin', "{0} signs in outside HivemindIDE, once: open a terminal, run `{1}` and use its sign-in there. HivemindIDE then uses that sign-in for every chat on {0}.", cli.name, cli.id === 'claude' ? 'claude' : `${cli.id} login`)) }]);
			return {};
		}

		const continuation = request.command === 'continue' ? await this.prepareContinuation(request.message, progress) : undefined;
		if (request.command === 'continue' && !continuation) {
			return {};
		}
		const question = continuation?.question ?? request.message;
		const session = request.sessionResource.toString();
		const node = await this.ensureSessionNode(session, question, route, continuation?.parent.id);
		if (node) {
			this.hivemindService.setRunning(node.id, true);
		}

		const usedFiles: URI[] = [];
		const answer = { text: '', route, switches: [] as string[], shellSession: node?.shellSession };
		try {
			const blocks = await this.readAttachments(request, progress, usedFiles);
			if (!this.primedShellSessions.has(session) && !node?.shellSession) {
				if (continuation) {
					blocks.unshift(continuation.block);
				}
				const hivemindBlock = await this.hivemindContext(session, continuation?.parent.id);
				if (hivemindBlock) {
					blocks.push(hivemindBlock);
				}
			}
			const contextText = formatContext(blocks, SHELL_CONTEXT_CHARS);
			const prompt = [contextText, request.modeInstructions?.content, question].filter(Boolean).join('\n\n');

			// Multitask mode always splits; otherwise the request has to ask for sub-agents.
			const multitask = /^multitask$/i.test(request.modeInstructions?.name ?? '');
			let usedModels: string;
			if (node && (multitask || wantsSubagents(question)) && !continuation) {
				const spawned = await this.spawnShellSubagents(route, question, node, progress, token);
				answer.text = spawned.text;
				usedModels = localize('hivemindChat.usedAgents', "{0} agents · {1}", spawned.routes.length, [...new Set(spawned.routes)].map(modelLabel).join(', '));
			} else {
				const first = await this.runShellTurn(session, node?.shellSession, prompt, answer, progress, token, history);
				usedModels = first && first !== answer.route.id ? `${modelLabel(first)} → ${modelLabel(answer.route.id)}` : modelLabel(answer.route.id);
			}
			this.primedShellSessions.add(session);
			await this.recordShellTurn(node, question, answer, usedFiles, token.isCancellationRequested);
			return { metadata: { hivemindModel: usedModels } };
		} catch (err) {
			if (token.isCancellationRequested) {
				return {};
			}
			this.logService.error('[HivemindShell] chat turn failed', err);
			await this.recordShellTurn(node, question, answer, usedFiles, true);
			return { errorDetails: { message: err instanceof Error ? err.message : String(err) }, metadata: { hivemindModel: modelLabel(answer.route.id) } };
		} finally {
			if (node) {
				this.hivemindService.setRunning(node.id, false);
			}
		}
	}

	/** The chat's node, created on its first turn so the graph shows it running before the answer exists. */
	private async ensureSessionNode(session: string, question: string, route: IShellRoute, parent: string | undefined): Promise<IHivemindNode | undefined> {
		if (!this.hivemindService.folder) {
			return undefined;
		}
		const existing = this.hivemindService.findByChatSession(session);
		if (existing) {
			return existing;
		}
		const parentNode = parent ? this.hivemindService.getNode(parent) : undefined;
		return this.hivemindService.createNode({
			title: parentNode ? `Continue: ${parentNode.title}` : titleOf(question),
			goal: question.slice(0, 1000),
			agent: SHELL_AGENT_NAME,
			model: route.id,
			parent,
			chatSession: session,
			route: route.id,
		});
	}

	/**
	 * Runs `prompt` in the key's shell session and streams it into the chat. When
	 * the route's provider runs out, the user's failover mode decides whether the
	 * same session moves to a backup route and carries on.
	 */
	/** Returns the route the turn started on; `answer.route` is where it ended. */
	private async runShellTurn(key: string, resume: string | undefined, prompt: string, answer: { text: string; route: IShellRoute; switches: string[]; shellSession?: string }, progress: (parts: IChatProgress[]) => void, token: CancellationToken, history: readonly IChatAgentHistoryEntry[] = []): Promise<string> {
		const tried = new Set<string>();
		let text = prompt;
		// A combo becomes its targets, in its strategy's order; a turn moves down them as they fail.
		const combo = answer.route.provider === COMBO_PROVIDER ? answer.route.model : undefined;
		const queue = this.shellAgentService.plan(answer.route);
		const first = queue.shift();
		if (!first) {
			throw new Error(localize('hivemindChat.emptyCombo', "The combo {0} has no targets it can run on. Add some in the Serviced AI tab.", answer.route.model));
		}
		answer.route = first;
		const startedOn = first.id;
		const onEvent = (event: HivemindShellEvent) => {
			if (event.kind === 'text') {
				answer.text += event.text;
				progress([{ kind: 'markdownContent', content: new MarkdownString(event.text) }]);
			} else if (event.kind === 'thought') {
				progress([{ kind: 'thinking', value: event.text }]);
			} else if (event.kind === 'tool' && event.title && (event.status === 'pending' || event.status === 'in_progress')) {
				progress([{ kind: 'progressMessage', content: new MarkdownString(event.title) }]);
			} else if (event.kind === 'truncated') {
				// Without this the answer looks like the model misunderstood; it never saw the question.
				progress([{
					kind: 'warning',
					content: new MarkdownString(localize('hivemindChat.truncated',
						"{0} could not fit this request: it was {1} tokens, but only the last {2} fit in the context Ollama loaded it with, so the start was cut off and this answer may not match what you asked. Raise Ollama's context length (Ollama → Settings → Context length), or use a model with a larger context.",
						event.model ?? localize('hivemindChat.truncated.model', "The local model"), event.sent.toLocaleString(), event.kept.toLocaleString())),
				}]);
			}
		};
		while (true) {
			tried.add(answer.route.provider);
			if (this.servicedAIService.isToolless(answer.route.id)) {
				const started = Date.now();
				await this.answerWithoutTools(prompt, answer, progress, token, history);
				this.servicedAIService.record(answer.route.id, true, Date.now() - started);
				return startedOn;
			}
			const started = Date.now();
			try {
				const result = await this.shellAgentService.run({ key, resume, route: answer.route, text, onEvent }, token);
				answer.shellSession = result.sessionId;
				this.servicedAIService.record(answer.route.id, true, Date.now() - started);
				if (combo) {
					this.servicedAIService.comboSucceeded(combo, answer.route.id);
				}
				return startedOn;
			} catch (err) {
				if (token.isCancellationRequested) {
					throw err;
				}
				const message = err instanceof Error ? err.message : String(err);
				if (isToolSupportError(message)) {
					// The model cannot be an agent; it can still answer. Said once per route.
					this.servicedAIService.markToolless(answer.route.id);
					progress([{ kind: 'progressMessage', content: new MarkdownString(localize('hivemindChat.toolless', "{0} cannot use tools, so it answers without working in the workspace. Pick a model with tool support to run it as an agent.", answer.route.model)) }]);
					continue;
				}
				// Not a failure of the service: the model just cannot be an agent (handled above).
				this.servicedAIService.record(answer.route.id, false, Date.now() - started, message);
				const failure = classifyProviderError(message);
				if (isFailoverReason(failure.kind)) {
					this.failoverService.markFailed(answer.route.provider, failure);
				}
				// A combo moves to its next target on any failure, before failover is asked.
				const comboNext = queue.shift();
				if (combo && comboNext) {
					const note = localize('hivemindChat.comboNext', "{0} failed ({1}). Combo {2} continued on {3}.", answer.route.id, describeFailure(failure), combo, comboNext.id);
					answer.switches.push(note);
					progress([{ kind: 'progressMessage', content: new MarkdownString(note) }]);
					text = this.continuation(prompt, text, answer, comboNext);
					answer.route = comboNext;
					continue;
				}
				if (!isFailoverReason(failure.kind)) {
					throw err;
				}
				// Installed agent CLIs are backups too, after the configured providers.
				const clis = this.shellAgentService.cliAgents.map(a => ({ name: a.name, url: `cli:${a.id}`, model: a.models[0] ?? 'default' }));
				const next = await this.failoverService.chooseNext(answer.route.provider, failure, tried, token, clis);
				const nextRoute = next && this.shellAgentService.getRoute(routeId(next.name, next.model));
				if (token.isCancellationRequested) {
					return startedOn;
				}
				if (!nextRoute) {
					throw new Error(this.stoppedMessage(answer.route.provider, failure));
				}
				const note = localize('failover.switched', "{0} {1}. Continued on {2} ({3}).", answer.route.provider, describeFailure(failure), nextRoute.provider, nextRoute.model);
				answer.switches.push(note);
				progress([{ kind: 'progressMessage', content: new MarkdownString(note) }]);
				text = this.continuation(prompt, text, answer, nextRoute);
				answer.route = nextRoute;
			}
		}
	}

	/**
	 * What to send the route a turn moves to. The same backend resumes its own session;
	 * another one starts fresh and needs the request and what was written so far.
	 */
	private continuation(prompt: string, current: string, answer: { text: string; route: IShellRoute }, next: IShellRoute): string {
		const backend = (route: IShellRoute) => this.shellAgentService.cliAgentFor(route)?.id ?? 'runtime';
		if (backend(next) === backend(answer.route)) {
			return answer.text || current !== prompt ? SHELL_RESUME_PROMPT : prompt;
		}
		return answer.text ? `${prompt}\n\n${SHELL_HANDOFF_NOTE}\n\n${answer.text}` : prompt;
	}

	/**
	 * Plans tasks on the parent's route, lets the user route each one (or runs them
	 * all on the parent's route), and runs every task as its own node and shell
	 * session, in parallel.
	 */
	private async spawnShellSubagents(parentRoute: IShellRoute, question: string, parent: IHivemindNode, progress: (parts: IChatProgress[]) => void, token: CancellationToken): Promise<{ text: string; routes: string[] }> {
		// Splitting the work is a planning task: it goes to the best planner, not necessarily the parent's model.
		const planner = this.shellAgentService.routeForTask('plan') ?? parentRoute;
		progress([{ kind: 'progressMessage', content: new MarkdownString(localize('localChat.planningAgentsOn', "Planning sub-agents on {0}…", planner.id)) }]);
		let tasks: string[] = [];
		try {
			tasks = parseTasks(await this.shellAgentService.complete(planner, SPLIT_PROMPT, question, token)).slice(0, MAX_SUBAGENTS);
		} catch (err) {
			this.logService.warn('[HivemindShell] could not plan sub-agents', err);
		}
		if (tasks.length < 2) {
			const brief = oneLine(question).slice(0, 180);
			tasks = [`[plan] Work out the approach: ${brief}`, `[code] Produce the result: ${brief}`];
		}

		// Each task starts on the model that suits its kind; the user can still choose, one task at a time.
		const ask = this.configurationService.getValue<boolean>(HivemindIDESettings.ShellAskRouteOnSpawn) !== false;
		const plan: { task: string; kind: TaskKind; route: IShellRoute }[] = [];
		for (const labelled of tasks) {
			const { kind, text: task } = parseTaskLabel(labelled);
			const suited = this.shellAgentService.routeForTask(kind) ?? parentRoute;
			const route = ask ? await this.shellAgentService.pickRoute(localize('shell.spawn.routeFor', "Route for sub-agent ({0}): {1}", taskLabel(kind), titleOf(task)), suited, token) : suited;
			if (token.isCancellationRequested) {
				return { text: '', routes: [] };
			}
			// Auto for a child means the model that suits its own task.
			plan.push({ task, kind, route: !route || route.provider === AUTO_PROVIDER ? suited : route });
		}
		progress([{
			kind: 'markdownContent',
			content: new MarkdownString(`${localize('localChat.spawning', "Spawning {0} agents.", plan.length)}\n\n${plan.map(p => `- ${p.task} · ${taskLabel(p.kind)} · \`${p.route.id}\``).join('\n')}\n\n`),
		}]);

		const children: { task: string; route: IShellRoute; node: IHivemindNode }[] = [];
		for (const { task, route } of plan) {
			const node = await this.hivemindService.createNode({ title: titleOf(task), goal: task, agent: SHELL_AGENT_NAME, model: route.id, parent: parent.id, route: route.id });
			if (node) {
				this.hivemindService.setRunning(node.id, true);
				children.push({ task, route, node });
			}
		}
		progress([{ kind: 'progressMessage', content: new MarkdownString(localize('localChat.agentsRunning', "{0} agents working in parallel…", children.length)) }]);

		const parts: string[] = [];
		const ended: string[] = [];
		await Promise.all(children.map(async ({ task, route, node }) => {
			const answer = { text: '', route, switches: [] as string[], shellSession: undefined as string | undefined };
			try {
				const prompt = `You are a sub-agent of a larger request. Do this task and nothing else, then reply with the result.\n\nTask: ${task}\n\nThe larger request, for context: ${question}`;
				// Sub-agents stream into their own nodes, not into the parent's chat.
				await this.runShellTurn(node.id, undefined, prompt, answer, () => { }, token);
			} catch (err) {
				if (!token.isCancellationRequested) {
					this.logService.warn(`[HivemindShell] sub-agent "${node.title}" failed`, err);
					answer.text = localize('localChat.agentFailed', "_This agent failed: {0}_", err instanceof Error ? err.message : String(err));
				}
			} finally {
				ended.push(answer.route.id);
				await this.recordShellTurn(node, task, answer, [], token.isCancellationRequested);
				this.hivemindService.setRunning(node.id, false);
			}
			const section = `## ${task} · \`${answer.route.id}\`\n\n${answer.text.trim()}`;
			parts.push(section);
			progress([{ kind: 'markdownContent', content: new MarkdownString(`${section}\n\n`) }]);
		}));
		// Where each child ended, after any failover along the way.
		return { text: parts.join('\n\n'), routes: ended };
	}

	/**
	 * A plain streamed answer on the route, for models that cannot call tools: the
	 * attachments and hivemind context in `prompt`, and as much of the chat so far as fits.
	 */
	private async answerWithoutTools(prompt: string, answer: { text: string; route: IShellRoute }, progress: (parts: IChatProgress[]) => void, token: CancellationToken, history: readonly IChatAgentHistoryEntry[]): Promise<void> {
		const earlier: IChatMessage[] = [];
		let used = 0;
		for (let i = history.length - 1; i >= 0; i--) {
			const entry = history[i];
			const reply = entry.response.map(part => part.kind === 'markdownContent' ? part.content.value : '').join('');
			used += entry.request.message.length + reply.length;
			if (used > TOOLLESS_HISTORY_CHARS) {
				break;
			}
			earlier.unshift(textMessage(ChatMessageRole.User, entry.request.message), textMessage(ChatMessageRole.Assistant, reply));
		}
		// The answer streams straight from the model, around the shell: say so, or the notch shows it as done.
		const sessionId = `direct:${generateUuid()}`;
		const provider = this.failoverService.providers.find(p => p.name === answer.route.provider);
		const local = answer.route.provider === LOCAL_ROUTE_PROVIDER || isLoopbackUrl(provider?.url);
		this.shellService.announce({ sessionId, kind: 'start', provider: answer.route.provider, model: answer.route.model, local, endpoint: provider?.url });
		try {
			const response = await this.shellAgentService.directChat(answer.route, [textMessage(ChatMessageRole.System, TOOLLESS_SYSTEM_PROMPT), ...earlier, textMessage(ChatMessageRole.User, prompt)], token);
			for await (const part of response.stream) {
				for (const item of Array.isArray(part) ? part : [part]) {
					if (item.type === 'text' && item.value) {
						answer.text += item.value;
						progress([{ kind: 'markdownContent', content: new MarkdownString(item.value) }]);
					} else if (item.type === 'thinking' && item.value) {
						progress([{ kind: 'thinking', value: item.value }]);
					}
				}
			}
			await response.result;
		} finally {
			this.shellService.announce({ sessionId, kind: 'end' });
		}
	}

	/** Records a shell turn on its node. Never fails the chat. */
	private async recordShellTurn(node: IHivemindNode | undefined, question: string, answer: { text: string; route: IShellRoute; switches: string[]; shellSession?: string }, files: readonly URI[], interrupted: boolean): Promise<void> {
		const folder = this.hivemindService.folder;
		if (!node || !folder) {
			return;
		}
		try {
			await this.hivemindService.recordTurn(node.id, {
				question,
				answer: answer.text,
				files: [...new Set(files.map(f => HivemindService.relativeTo(folder, f)))],
				model: answer.route.id,
				interrupted,
				switches: answer.switches,
				route: answer.route.id,
				shellSession: answer.shellSession,
			});
		} catch (err) {
			this.logService.warn('[Hivemind] could not record this turn', err);
		}
	}

	/** Why the answer stopped instead of switching, and what the user can do about it. */
	private stoppedMessage(name: string, failure: IProviderFailure): string {
		const what = localize('failover.stopped', "{0} {1}: {2}", name, describeFailure(failure), failure.message);
		if (this.failoverService.mode === 'off') {
			return what;
		}
		if (this.failoverService.providers.length === 0) {
			return `${what}\n\n${localize('failover.noProviders', "To continue on another provider when this happens, run HivemindIDE: Add AI Provider… Then reply \"continue\".")}`;
		}
		return `${what}\n\n${localize('failover.resume', "Reply \"continue\" to resume this answer.")}`;
	}

	private async readAttachments(request: IChatAgentRequest, progress: (parts: IChatProgress[]) => void, usedFiles: URI[]): Promise<IContextBlock[]> {
		const blocks: IContextBlock[] = [];
		for (const entry of request.variables.variables) {
			// The customizations index lists skills and agents for other chat agents,
			// and it is easily 15k+ characters.
			if ((entry.kind === 'implicit' && !entry.enabled) || entry.kind === 'promptText') {
				continue;
			}
			if (entry.kind === 'paste') {
				blocks.push({ label: entry.name, text: entry.code });
				continue;
			}
			const value = entry.value;
			if (typeof value === 'string') {
				blocks.push({ label: entry.name, text: value.slice(0, MAX_ATTACHMENT_CHARS) });
			} else if (URI.isUri(value) || isLocation(value)) {
				const block = await this.readResource(value);
				if (block) {
					const automatic = entry.kind === 'promptFile' && entry.automaticallyAdded;
					blocks.push(automatic ? { ...block, text: block.text.slice(0, MAX_AUTOMATIC_CHARS), automatic } : block);
					if (!automatic) {
						usedFiles.push(URI.isUri(value) ? value : value.uri);
					}
					progress([{ kind: 'reference', reference: value }]);
				}
			}
		}
		return blocks;
	}

	private async readResource(value: URI | Location): Promise<IContextBlock | undefined> {
		const uri = URI.isUri(value) ? value : value.uri;
		try {
			const lines = (await this.fileService.readFile(uri)).value.toString().split(/\r?\n/);
			const start = URI.isUri(value) ? 1 : value.range.startLineNumber;
			const end = URI.isUri(value) ? lines.length : value.range.endLineNumber;
			const text = lines.slice(start - 1, end).join('\n').slice(0, MAX_ATTACHMENT_CHARS);
			return { label: `${this.labelService.getUriLabel(uri, { relative: true })}:${start}`, text };
		} catch {
			return undefined; // folders and unreadable resources contribute nothing
		}
	}

	/**
	 * Loads the node named by `/continue <id> [question]`. When the id is
	 * missing or unknown, lists recent nodes to pick from and returns undefined.
	 */
	private async prepareContinuation(message: string, progress: (parts: IChatProgress[]) => void): Promise<{ parent: IHivemindNode; question: string; block: IContextBlock } | undefined> {
		const [id, ...rest] = message.replace(/^\s*\/continue\b/, '').trim().split(/\s+/);
		const parent = id ? this.hivemindService.getNode(id) : undefined;
		if (!parent) {
			const recent = this.hivemindService.nodes.slice(0, 8);
			const text = recent.length
				? `${localize('hivemind.continue.which', "Which node? Reply with `/continue <id>`, or use **Continue a Hivemind Node…** from the Command Palette.")}\n\n${recent.map(n => `- \`${n.id}\`: ${n.title} (${n.status}, ${n.author}, ${n.agent})`).join('\n')}`
				: localize('hivemind.continue.empty', "This project's hivemind has no nodes yet. They appear as you and other AIs work here.");
			progress([{ kind: 'markdownContent', content: new MarkdownString(text) }]);
			return undefined;
		}
		progress([{ kind: 'reference', reference: parent.uri }]);
		const full = await this.hivemindService.readNodeText(parent.id) ?? '';
		// Spelled out rather than "see the node": small models follow an explicit
		// goal and next step far better than an instruction to go find them.
		const question = rest.join(' ') || [
			`Continue this work, which ${parent.author}'s ${parent.agent} left ${parent.status === 'done' ? 'done' : 'unfinished'}.`,
			`Goal: ${oneLine(parent.goal)}`,
			`Where it stands: ${oneLine(parent.handoff)}`,
			'Do the next step now. Start with one sentence on what you are doing.',
		].join('\n');
		return {
			parent,
			question,
			block: { label: `.hivemind/nodes/${parent.id}.md`, text: full.slice(0, MAX_CONTINUED_NODE_CHARS) },
		};
	}

	/** Project notes and the latest nodes, so every answer starts from what others already did. */
	private async hivemindContext(session: string, exclude: string | undefined): Promise<IContextBlock | undefined> {
		if (!this.hivemindService.folder || this.configurationService.getValue<boolean>(HivemindIDESettings.HivemindIncludeInChat) === false) {
			return undefined;
		}
		const current = this.hivemindService.findByChatSession(session)?.id;
		const notes = await this.hivemindService.readProjectNotes();
		const recent = this.hivemindService.nodes.filter(n => n.id !== current && n.id !== exclude).slice(0, 5);
		if (!notes && recent.length === 0) {
			return undefined;
		}
		const parts: string[] = [];
		if (notes) {
			parts.push(`Project notes:\n${notes.slice(0, 1200)}`);
		}
		if (recent.length) {
			parts.push(`Recent work in this project, newest first:\n${recent.map(n => `- [${n.status}] ${n.title} (${n.author}, ${n.agent}, node ${n.id}): ${n.handoff.replace(/\s+/g, ' ').slice(0, 220)}`).join('\n')}`);
		}
		return { label: '.hivemind', text: parts.join('\n\n').slice(0, MAX_HIVEMIND_CONTEXT_CHARS), automatic: true };
	}
}

/** Attachments as <context> blocks: the user's own first, then automatic instruction files, within `budgetChars`. */
function formatContext(blocks: readonly IContextBlock[], budgetChars: number): string {
	const parts: string[] = [];
	let remaining = budgetChars;
	for (const block of [...blocks.filter(b => !b.automatic), ...blocks.filter(b => b.automatic)]) {
		if (remaining < 200) {
			break;
		}
		const room = remaining - 100;
		const text = block.text.length > room ? `${block.text.slice(0, room)}\n…` : block.text;
		const formatted = `<context source="${block.label}">\n${text}\n</context>`;
		parts.push(formatted);
		remaining -= formatted.length;
	}
	return parts.join('\n');
}

function wantsSubagents(message: string): boolean {
	return /\b(spawn|sub-?agents?|multiple agents)\b/i.test(message);
}

/**
 * The list items of a plan. Models often wrap the list in a code fence or bold its
 * items, so fences (and anything inside them) are skipped, emphasis is stripped, and
 * an item must contain a word: "1. ```" is not a task.
 */
export function parseTasks(text: string): string[] {
	const tasks: string[] = [];
	let inFence = false;
	for (const line of text.split('\n')) {
		if (/^\s*(?:(?:[-*]|\d+[.)])\s+)?(?:```|~~~)/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) {
			continue;
		}
		const task = /^\s*(?:[-*]|\d+[.)])\s+(\S.*)$/.exec(line)?.[1].replace(/\*\*|__|`/g, '').trim();
		if (task && /\p{L}{3}/u.test(task)) {
			tasks.push(task);
		}
	}
	return tasks;
}

/**
 * A node title from a message: its first line that has words in it, without list
 * markers, headings or emphasis, cut to a card-sized length. A message that opens
 * with a code fence would otherwise be titled "```".
 */
export function titleOf(text: string): string {
	const line = text.split('\n')
		.map(l => l.replace(/^\s*(?:#+|[-*>]|\d+[.)])\s+/, '').replace(/\*\*|__|`/g, '').trim())
		.find(l => /\p{L}{3}/u.test(l)) ?? oneLine(text);
	return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line;
}

function oneLine(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

function textMessage(role: ChatMessageRole, value: string): IChatMessage {
	return { role, content: [{ type: 'text', value }] };
}

function taskLabel(task: TaskKind): string {
	switch (task) {
		case 'plan': return localize('task.plan', "Planning");
		case 'code': return localize('task.code', "Coding");
		case 'ask': return localize('task.ask', "Answering");
		case 'subagent': return localize('task.subagent', "Sub-agent work");
		case 'summarize': return localize('task.summarize', "Summarizing");
	}
}

/** "Claude Code · opus" for `Claude Code/opus`: how the chat names the model that answered. */
function modelLabel(routeId: string): string {
	const slash = routeId.indexOf('/');
	return slash < 0 ? routeId : `${routeId.slice(0, slash)} · ${routeId.slice(slash + 1)}`;
}
