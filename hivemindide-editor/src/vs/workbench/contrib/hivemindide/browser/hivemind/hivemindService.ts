/*---------------------------------------------------------------------------------------------
 *  HivemindIDE hivemind: the project's shared AI memory in `.hivemind/`.
 *
 *  Scaffolds the folder in every trusted workspace folder, keeps the pointer
 *  block in AGENTS.md / CLAUDE.md current, loads the node graph, and writes
 *  the nodes HivemindIDE's own AI produces. Other tools write the same files
 *  by hand following .hivemind/README.md; a file watcher picks their nodes
 *  (and nodes arriving by `git pull`) up.
 *
 *  Works through IFileService only, so it runs in desktop, web and remote
 *  windows alike.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler, SequencerByKey } from '../../../../../base/common/async.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { basename, isEqual, joinPath, relativePath } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { HIVEMINDIDE_CONFIG_SECTION, HivemindIDESettings } from '../../common/hivemindideConfiguration.js';
import { getSection, IHivemindNodeDocument, IHivemindNodeHeader, newHivemindNodeId, parseFileList, parseHivemindNode, serializeHivemindNode, setSection } from '../../common/hivemindNode.js';
import { HIVEMIND_FOLDER, HIVEMIND_NODES_FOLDER, HIVEMIND_POINTER_BLOCK, HIVEMIND_POINTER_END, HIVEMIND_POINTER_FILES, HIVEMIND_POINTER_START, HIVEMIND_PROJECT_TEMPLATE, HIVEMIND_README, HivemindNodeStatus } from '../../common/hivemindProtocol.js';

export interface IHivemindNode extends IHivemindNodeHeader {
	readonly uri: URI;
	readonly goal: string;
	readonly handoff: string;
	readonly files: readonly string[];
	/** The chat session this node records, when HivemindIDE's chat wrote it. */
	readonly chatSession?: string;
	/** Set when the run was stopped from the review. */
	readonly killed?: boolean;
	/** `provider/model` of the hivemind shell route it runs on. */
	readonly route?: string;
	/** Its hivemind shell session, which can be resumed to continue it. */
	readonly shellSession?: string;
}

export interface IHivemindTurn {
	readonly question: string;
	readonly answer: string;
	/** Workspace-relative paths the turn read or cited. */
	readonly files: readonly string[];
	readonly model?: string;
	/** The answer was cut off; the node is left `paused` with a handoff that says so. */
	readonly interrupted?: boolean;
	/** Provider switches during the answer, e.g. "sonnet ran out of quota. Continued on OpenAI (gpt-5)." */
	readonly switches?: readonly string[];
	/** The hivemind shell route and session that answered, when a shell route did. */
	readonly route?: string;
	readonly shellSession?: string;
}

export const IHivemindService = createDecorator<IHivemindService>('hivemindideHivemindService');

export interface IHivemindService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;

	/** `.hivemind` of the first workspace folder, once it exists. */
	readonly folder: URI | undefined;
	/** All nodes, most recently updated first. */
	readonly nodes: readonly IHivemindNode[];
	readonly author: string;

	getNode(id: string): IHivemindNode | undefined;
	findByChatSession(session: string): IHivemindNode | undefined;
	/** True while a chat turn or a spawned sub-agent is generating for this node. Not stored in the file. */
	isRunning(id: string): boolean;
	setRunning(id: string, running: boolean): void;
	readNodeText(id: string): Promise<string | undefined>;
	/** project.md without template comments and empty headings, or undefined when there is nothing in it. */
	readProjectNotes(): Promise<string | undefined>;

	createNode(init: { title: string; goal: string; agent: string; model?: string; parent?: string; chatSession?: string; route?: string }): Promise<IHivemindNode | undefined>;
	recordTurn(id: string, turn: IHivemindTurn): Promise<void>;
	setStatus(id: string, status: HivemindNodeStatus): Promise<void>;
	/** Stops a run for good: status `done`, handoff says it was killed, and later turns do not revive it. */
	killNode(id: string): Promise<void>;
	/**
	 * Marks a node deleted immediately, so a chat that is still finishing does not
	 * write it back. Call this before cancelling the chat, then `deleteNode`.
	 */
	beginDelete(id: string): void;
	/** Deletes the node file and drops it from the graph. */
	deleteNode(id: string): Promise<void>;
}

const MAX_NODES = 500;
const MAX_LOG_ENTRIES = 30;
const MAX_FILES = 30;
const LOG_ANSWER_CHARS = 1500;
const HANDOFF_ANSWER_CHARS = 700;

export class HivemindService extends Disposable implements IHivemindService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _folder: URI | undefined;
	private _nodes: IHivemindNode[] = [];
	private userName = '';
	private readonly writes = new SequencerByKey<string>();
	/** Node ids removed from the graph. A late turn must not write them back. */
	private readonly deletedIds = new Set<string>();
	/** Chat sessions whose node was just deleted. Cleared shortly after, so a later message can record again. */
	private readonly blockedSessions = new Set<string>();
	/** Nodes whose model call is in flight. Drives the graph's running pill. */
	private readonly runningIds = new Set<string>();
	private readonly reload = this._register(new RunOnceScheduler(() => this.loadNodes(), 300));

	constructor(
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IPathService private readonly pathService: IPathService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		this._register(this.fileService.onDidFilesChange(e => {
			if (this._folder && e.affects(this._folder)) {
				this.reload.schedule();
			}
		}));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.initialize()));
		this._register(this.workspaceTrustManagementService.onDidChangeTrust(() => this.initialize()));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(HivemindIDESettings.HivemindEnabled) || e.affectsConfiguration(HivemindIDESettings.HivemindAgentPointers)) {
				this.initialize();
			} else if (e.affectsConfiguration(HIVEMINDIDE_CONFIG_SECTION)) {
				this._onDidChange.fire();
			}
		}));

		this.pathService.userHome().then(home => this.userName = basename(home));
		this.workspaceTrustManagementService.workspaceTrustInitialized.then(() => this.initialize());
	}

	get folder(): URI | undefined {
		return this._folder;
	}

	get nodes(): readonly IHivemindNode[] {
		return this._nodes;
	}

	get author(): string {
		return this.configurationService.getValue<string>(HivemindIDESettings.HivemindAuthor)?.trim() || this.userName || 'unknown';
	}

	private get enabled(): boolean {
		return this.configurationService.getValue<boolean>(HivemindIDESettings.HivemindEnabled) !== false;
	}

	// ---- Scaffolding -------------------------------------------------------------------

	private async initialize(): Promise<void> {
		const folders = this.workspaceContextService.getWorkspace().folders;
		if (!this.enabled || !this.workspaceTrustManagementService.isWorkspaceTrusted() || folders.length === 0) {
			this._folder = undefined;
			this._nodes = [];
			this._onDidChange.fire();
			return;
		}

		const home = await this.pathService.userHome();
		let primary: URI | undefined;
		for (const folder of folders) {
			// Never litter a home directory or a read-only location.
			if (isEqual(folder.uri, home) || this.fileService.hasCapability(folder.uri, FileSystemProviderCapabilities.Readonly)) {
				continue;
			}
			try {
				await this.scaffold(folder.uri);
				primary ??= joinPath(folder.uri, HIVEMIND_FOLDER);
			} catch (err) {
				this.logService.warn(`[Hivemind] could not set up ${folder.uri.toString()}`, err);
			}
		}
		this._folder = primary;
		await this.loadNodes();
	}

	private async scaffold(root: URI): Promise<void> {
		const hivemind = joinPath(root, HIVEMIND_FOLDER);
		const nodes = joinPath(hivemind, HIVEMIND_NODES_FOLDER);
		if (!await this.fileService.exists(nodes)) {
			await this.fileService.createFolder(nodes);
		}
		// Git does not track empty folders; keep nodes/ in the repo from the start.
		await this.writeIfMissing(joinPath(nodes, '.gitkeep'), '');
		await this.writeIfDifferent(joinPath(hivemind, 'README.md'), HIVEMIND_README);
		await this.writeIfMissing(joinPath(hivemind, 'project.md'), HIVEMIND_PROJECT_TEMPLATE);

		if (this.configurationService.getValue<boolean>(HivemindIDESettings.HivemindAgentPointers) !== false) {
			for (const name of HIVEMIND_POINTER_FILES) {
				await this.ensurePointer(joinPath(root, name));
			}
		}
	}

	/** Adds or refreshes the managed block; everything outside the markers is the user's. */
	private async ensurePointer(file: URI): Promise<void> {
		const existing = await this.readText(file);
		let next: string;
		if (existing === undefined) {
			next = `${HIVEMIND_POINTER_BLOCK}\n`;
		} else {
			const start = existing.indexOf(HIVEMIND_POINTER_START);
			const end = existing.indexOf(HIVEMIND_POINTER_END);
			next = start >= 0 && end > start
				? existing.slice(0, start) + HIVEMIND_POINTER_BLOCK + existing.slice(end + HIVEMIND_POINTER_END.length)
				: `${existing.replace(/\s*$/, '')}\n\n${HIVEMIND_POINTER_BLOCK}\n`;
		}
		if (next !== existing) {
			await this.fileService.writeFile(file, VSBuffer.fromString(next));
		}
	}

	private async writeIfMissing(file: URI, content: string): Promise<void> {
		if (!await this.fileService.exists(file)) {
			await this.fileService.writeFile(file, VSBuffer.fromString(content));
		}
	}

	private async writeIfDifferent(file: URI, content: string): Promise<void> {
		if (await this.readText(file) !== content) {
			await this.fileService.writeFile(file, VSBuffer.fromString(content));
		}
	}

	private async readText(file: URI): Promise<string | undefined> {
		try {
			return (await this.fileService.readFile(file)).value.toString();
		} catch {
			return undefined;
		}
	}

	// ---- Reading -------------------------------------------------------------------------

	private async loadNodes(): Promise<void> {
		const folder = this._folder;
		if (!folder) {
			return;
		}
		let entries: URI[] = [];
		try {
			const stat = await this.fileService.resolve(joinPath(folder, HIVEMIND_NODES_FOLDER));
			entries = (stat.children ?? [])
				.filter(c => c.isFile && c.name.endsWith('.md'))
				.map(c => c.resource)
				// Ids start with a UTC timestamp, so name order is roughly age order.
				.sort((a, b) => basename(b).localeCompare(basename(a)))
				.slice(0, MAX_NODES);
		} catch {
			// no nodes folder yet
		}

		const nodes: IHivemindNode[] = [];
		await Promise.all(entries.map(async uri => {
			const text = await this.readText(uri);
			const doc = text !== undefined ? parseHivemindNode(text) : undefined;
			if (doc) {
				nodes.push(toNode(doc, uri));
			}
		}));
		nodes.sort((a, b) => b.updated.localeCompare(a.updated));
		this._nodes = nodes;
		this._onDidChange.fire();
	}

	getNode(id: string): IHivemindNode | undefined {
		return this._nodes.find(n => n.id === id);
	}

	findByChatSession(session: string): IHivemindNode | undefined {
		return this._nodes.find(n => n.chatSession === session);
	}

	isRunning(id: string): boolean {
		return this.runningIds.has(id);
	}

	setRunning(id: string, running: boolean): void {
		const was = this.runningIds.has(id);
		if (running) {
			this.runningIds.add(id);
		} else {
			this.runningIds.delete(id);
		}
		if (was !== running) {
			this._onDidChange.fire();
		}
	}

	async readNodeText(id: string): Promise<string | undefined> {
		const node = this.getNode(id);
		return node ? this.readText(node.uri) : undefined;
	}

	async readProjectNotes(): Promise<string | undefined> {
		if (!this._folder) {
			return undefined;
		}
		const text = await this.readText(joinPath(this._folder, 'project.md'));
		if (!text) {
			return undefined;
		}
		const cleaned = text
			.replace(/<!--[\s\S]*?-->/g, '')
			// Drop headings with nothing under them, so an untouched template reads as empty.
			.replace(/^#{1,6} .*\n(?=\s*(#{1,6} |$))/gm, '')
			.replace(/^# Project notes\s*$/m, '')
			.trim();
		return cleaned || undefined;
	}

	// ---- Writing -------------------------------------------------------------------------

	async createNode(init: { title: string; goal: string; agent: string; model?: string; parent?: string; chatSession?: string; route?: string }): Promise<IHivemindNode | undefined> {
		const folder = this._folder;
		if (!folder || (init.chatSession && this.blockedSessions.has(init.chatSession))) {
			return undefined;
		}
		const now = new Date();
		const title = init.title.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Untitled work';
		const id = newHivemindNodeId(title, now);
		const doc: IHivemindNodeDocument = {
			header: {
				id,
				title,
				parent: init.parent,
				status: 'active',
				author: this.author,
				agent: init.agent,
				model: init.model,
				created: now.toISOString(),
				updated: now.toISOString(),
			},
			extraHeader: [
				...(init.chatSession ? [['chatSession', init.chatSession] as [string, string]] : []),
				...(init.route ? [['route', init.route] as [string, string]] : []),
			],
			sections: [
				['Goal', init.goal.trim()],
				['Handoff', 'Just started.'],
				['Files', ''],
				['Log', ''],
			],
		};
		const uri = joinPath(folder, HIVEMIND_NODES_FOLDER, `${id}.md`);
		await this.fileService.writeFile(uri, VSBuffer.fromString(serializeHivemindNode(doc)));
		const node = toNode(doc, uri);
		this._nodes = [node, ...this._nodes];
		this._onDidChange.fire();
		return node;
	}

	recordTurn(id: string, turn: IHivemindTurn): Promise<void> {
		return this.writes.queue(id, async () => {
			const node = this.getNode(id);
			const text = node ? await this.readText(node.uri) : undefined;
			const doc = text !== undefined ? parseHivemindNode(text) : undefined;
			if (!node || !doc || isKilled(doc) || this.deletedIds.has(id)) {
				return;
			}
			const now = new Date();
			doc.header = {
				...doc.header,
				status: turn.interrupted ? 'paused' : 'active',
				model: turn.model ?? doc.header.model,
				updated: now.toISOString(),
			};

			setExtraHeader(doc, 'route', turn.route);
			setExtraHeader(doc, 'shellSession', turn.shellSession);

			const question = excerpt(turn.question, 400);
			// The handoff is prose for the next reader; code lives in the log and the files.
			const answer = excerpt(withoutCode(turn.answer), HANDOFF_ANSWER_CHARS);
			setSection(doc, 'Handoff', [
				`Last request (${this.author}, ${formatTime(now)}): ${question}`,
				'',
				turn.interrupted
					? `The answer was cut off part-way. What it had written so far: ${answer || '(nothing yet)'}`
					: `Latest answer, in short: ${answer}`,
				'',
				turn.interrupted
					? 'Next: resume that answer (in HivemindIDE, reply "continue" in the same chat).'
					: 'Next: continue from the latest answer, or mark this node done if the goal is met.',
			].join('\n'));

			const files = [...new Set([...parseFileList(getSection(doc, 'Files')), ...turn.files])].slice(0, MAX_FILES);
			setSection(doc, 'Files', files.map(f => `- ${f}`).join('\n'));

			const entry = [
				`### ${formatTime(now)} · ${this.author}`,
				`**Asked:** ${excerpt(turn.question, 600)}`,
				'',
				`**${turn.interrupted ? 'Answered (cut off)' : 'Answered'}:** ${excerpt(turn.answer, LOG_ANSWER_CHARS) || '(no text)'}`,
				...(turn.switches?.length ? ['', `**Switched provider:** ${turn.switches.join(' ')}`] : []),
			].join('\n');
			const entries = getSection(doc, 'Log').split(/(?=^### )/m).map(e => e.trim()).filter(Boolean);
			setSection(doc, 'Log', [...entries, entry].slice(-MAX_LOG_ENTRIES).join('\n\n'));

			await this.fileService.writeFile(node.uri, VSBuffer.fromString(serializeHivemindNode(doc)));
			this.replaceNode(toNode(doc, node.uri));
		});
	}

	killNode(id: string): Promise<void> {
		return this.writes.queue(id, async () => {
			const node = this.getNode(id);
			const text = node ? await this.readText(node.uri) : undefined;
			const doc = text !== undefined ? parseHivemindNode(text) : undefined;
			if (!node || !doc || isKilled(doc)) {
				return;
			}
			const now = new Date();
			doc.header = { ...doc.header, status: 'done', updated: now.toISOString() };
			setExtraHeader(doc, 'killed', 'true');
			setSection(doc, 'Handoff', 'Killed. This run was stopped from the review and should not be resumed.');
			const entry = [
				`### ${formatTime(now)} · ${this.author}`,
				'Killed. The run was stopped from the review.',
			].join('\n');
			const entries = getSection(doc, 'Log').split(/(?=^### )/m).map(e => e.trim()).filter(Boolean);
			setSection(doc, 'Log', [...entries, entry].slice(-MAX_LOG_ENTRIES).join('\n\n'));
			await this.fileService.writeFile(node.uri, VSBuffer.fromString(serializeHivemindNode(doc)));
			this.replaceNode(toNode(doc, node.uri));
		});
	}

	beginDelete(id: string): void {
		const node = this.getNode(id);
		if (!node) {
			return;
		}
		this.deletedIds.add(id);
		if (node.chatSession) {
			const session = node.chatSession;
			this.blockedSessions.add(session);
			setTimeout(() => this.blockedSessions.delete(session), 2000);
		}
	}

	deleteNode(id: string): Promise<void> {
		this.beginDelete(id);
		const node = this.getNode(id);
		if (!node) {
			return Promise.resolve();
		}
		return this.writes.queue(id, async () => {
			try {
				await this.fileService.del(node.uri);
			} catch (err) {
				this.logService.warn(`[Hivemind] could not delete ${node.uri.toString()}`, err);
			}
			this._nodes = this._nodes.filter(n => n.id !== id);
			this.runningIds.delete(id);
			this._onDidChange.fire();
		});
	}

	setStatus(id: string, status: HivemindNodeStatus): Promise<void> {
		return this.writes.queue(id, async () => {
			const node = this.getNode(id);
			const text = node ? await this.readText(node.uri) : undefined;
			const doc = text !== undefined ? parseHivemindNode(text) : undefined;
			if (!node || !doc || doc.header.status === status) {
				return;
			}
			doc.header = { ...doc.header, status, updated: new Date().toISOString() };
			await this.fileService.writeFile(node.uri, VSBuffer.fromString(serializeHivemindNode(doc)));
			this.replaceNode(toNode(doc, node.uri));
		});
	}

	private replaceNode(node: IHivemindNode): void {
		this._nodes = [node, ...this._nodes.filter(n => n.id !== node.id)];
		this._onDidChange.fire();
	}

	/** Workspace-relative path for a file, for the Files section. */
	static relativeTo(folder: URI | undefined, file: URI): string {
		const root = folder ? joinPath(folder, '..') : undefined;
		return (root && relativePath(root, file)) ?? file.path;
	}
}

function toNode(doc: IHivemindNodeDocument, uri: URI): IHivemindNode {
	return {
		...doc.header,
		uri,
		goal: getSection(doc, 'Goal'),
		handoff: getSection(doc, 'Handoff'),
		files: parseFileList(getSection(doc, 'Files')),
		chatSession: doc.extraHeader.find(([key]) => key === 'chatSession')?.[1],
		killed: isKilled(doc),
		route: doc.extraHeader.find(([key]) => key === 'route')?.[1],
		shellSession: doc.extraHeader.find(([key]) => key === 'shellSession')?.[1],
	};
}

function setExtraHeader(doc: IHivemindNodeDocument, key: string, value: string | undefined): void {
	if (!value) {
		return;
	}
	const existing = doc.extraHeader.find(([k]) => k === key);
	if (existing) {
		existing[1] = value;
	} else {
		doc.extraHeader.push([key, value]);
	}
}

function isKilled(doc: IHivemindNodeDocument): boolean {
	return doc.extraHeader.some(([key, value]) => key === 'killed' && value === 'true');
}

function withoutCode(markdown: string): string {
	return markdown.replace(/```[\s\S]*?(```|$)/g, ' (code) ');
}

function excerpt(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function formatTime(date: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`;
}
