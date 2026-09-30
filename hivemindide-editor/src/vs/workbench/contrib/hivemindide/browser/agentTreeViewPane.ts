/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Native sidebar pane: author+AI root → sub-agent spawn tree.
 *--------------------------------------------------------------------------------------------*/

import './media/agentTree.css';
import { MutableDisposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename, dirname } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { CoordinationClient, StreamEvent } from '../../../services/hivemindide/common/coordinationClient.js';
import { IChatService } from '../../chat/common/chatService/chatService.js';
import { IAgentDetail, IAgentTree, IAgentTreeNode, isAgentTree, HIVEMINDIDE_AGENT_TREE_VIEW_ID, detailFromHivemind, resolveAgentDetail } from '../common/agentTree.js';
import { getSection, parseHivemindNode } from '../common/hivemindNode.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { AgentDetailEditor } from './agentDetailEditor.js';
import { AgentDetailInput } from './agentDetailInput.js';
import { IHivemindNode, IHivemindService } from './hivemind/hivemindService.js';
import { HivemindIDESettings, HIVEMINDIDE_CONFIG_SECTION } from '../common/hivemindideConfiguration.js';
import { AgentTreeWidget } from './agentTreeWidget.js';

const HIVEMIND_RUN_ID = 'hivemind';
const HIVEMIND_ROOT_ID = 'hivemind-root';
/** Top-level nodes drawn; older ones are still in .hivemind/nodes and the Continue picker. */
const MAX_HIVEMIND_ROOTS = 40;

export class AgentTreeViewPane extends ViewPane {

	static readonly ID = HIVEMINDIDE_AGENT_TREE_VIEW_ID;

	private widget: AgentTreeWidget | undefined;
	private readonly socket = this._register(new MutableDisposable<IDisposable>());
	private readonly reconnect = this._register(new MutableDisposable<IDisposable>());
	private liveTree: IAgentTree | undefined;
	private currentTree: IAgentTree | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IHivemindService private readonly hivemindService: IHivemindService,
		@IEditorService private readonly editorService: IEditorService,
		@IChatService private readonly chatService: IChatService,
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		this._register(this.hivemindService.onDidChange(() => {
			this.refresh();
			this.refreshOpenReviews();
		}));

		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(HIVEMINDIDE_CONFIG_SECTION)) {
				this.reconnectStream();
				this.refresh();
			}
		}));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.widget = this._register(new AgentTreeWidget(container));
		this._register(this.widget.onDidOpenNode(nodeId => this.openDetail(nodeId)));
		this.reconnectStream();
		this.refresh();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.widget?.layout(height, width);
	}

	/** Toolbar / command: redraw from the latest live tree or hivemind nodes. */
	resample(): void {
		this.refresh();
	}

	/** Command and child rows in an open review. */
	openNode(nodeId: string): void {
		void this.openDetail(nodeId);
	}

	/** Stops the chat behind this node, then marks the node killed. Returns the updated review. */
	async killNode(nodeId: string): Promise<IAgentDetail | undefined> {
		const node = this.hivemindService.getNode(nodeId);
		if (!node || node.killed || node.status === 'done') {
			return undefined;
		}
		const confirmed = await this.dialogService.confirm({
			type: 'warning',
			message: localize('hivemindide.agentDetail.killConfirm', "Kill this run?"),
			detail: localize('hivemindide.agentDetail.killConfirmDetail', "Stops the chat if it is still generating, and marks \"{0}\" done so it is not resumed.", node.title),
			primaryButton: localize('hivemindide.agentDetail.kill', "Kill"),
		});
		if (!confirmed.confirmed) {
			return this.currentTree ? this.hivemindDetail(this.currentTree, nodeId) : undefined;
		}
		if (node.chatSession) {
			try {
				await this.chatService.cancelCurrentRequestForSession(URI.parse(node.chatSession), 'hivemindide.kill');
			} catch {
				// The node is still marked killed below, even if the chat was already gone.
			}
		}
		await this.hivemindService.killNode(nodeId);
		return this.currentTree ? this.hivemindDetail(this.currentTree, nodeId) : undefined;
	}

	/** Deletes the node file and removes it from the graph. Returns whether it was deleted. */
	async deleteNode(nodeId: string): Promise<boolean> {
		const node = this.hivemindService.getNode(nodeId);
		if (!node) {
			return false;
		}
		const confirmed = await this.dialogService.confirm({
			type: 'warning',
			message: localize('hivemindide.agentDetail.deleteConfirm', "Delete this node?"),
			detail: localize('hivemindide.agentDetail.deleteConfirmDetail', "Removes \"{0}\" from the graph and deletes its file. This cannot be undone.", node.title),
			primaryButton: localize('hivemindide.agentDetail.delete', "Delete"),
		});
		if (!confirmed.confirmed) {
			return false;
		}
		this.hivemindService.beginDelete(nodeId);
		if (node.chatSession) {
			try {
				await this.chatService.cancelCurrentRequestForSession(URI.parse(node.chatSession), 'hivemindide.delete');
			} catch {
				// The file is still deleted below, even if the chat was already gone.
			}
		}
		await this.hivemindService.deleteNode(nodeId);
		return true;
	}

	private async openDetail(nodeId: string): Promise<void> {
		const tree = this.currentTree;
		if (!tree) {
			return;
		}
		const detail = tree.run_id === HIVEMIND_RUN_ID && nodeId !== HIVEMIND_ROOT_ID
			? await this.hivemindDetail(tree, nodeId)
			: resolveAgentDetail(tree, nodeId);
		if (!detail) {
			return;
		}
		await this.editorService.openEditor(this.instantiationService.createInstance(AgentDetailInput, detail), { pinned: true });
	}

	/** Goal, handoff, and log from the node file, in the review layout. */
	private async hivemindDetail(tree: IAgentTree, nodeId: string): Promise<IAgentDetail | undefined> {
		const base = resolveAgentDetail(tree, nodeId);
		const node = this.hivemindService.getNode(nodeId);
		if (!base || !node) {
			return base;
		}
		const text = await this.hivemindService.readNodeText(nodeId);
		const doc = text ? parseHivemindNode(text) : undefined;
		const parent = node.parent ? this.hivemindService.getNode(node.parent) : undefined;
		return detailFromHivemind({
			id: node.id,
			title: node.title,
			author: node.author,
			agent: node.agent,
			model: node.model ?? null,
			status: node.status === 'paused' ? 'idle' : node.status,
			running: this.hivemindService.isRunning(node.id),
			goal: node.goal,
			handoff: node.handoff,
			files: node.files,
			parentTitle: parent?.title,
			killed: node.killed,
			log: parseLog(doc ? getSection(doc, 'Log') : ''),
			spawned: base.spawned,
		});
	}

	private refresh(): void {
		if (!this.widget) {
			return;
		}

		if (!this.configurationService.getValue<boolean>(HivemindIDESettings.AgentTreeEnabled)) {
			this.currentTree = undefined;
			this.widget.setConnectionState('empty', localize('hivemindide.agentTree.disabled', "Agents view disabled in settings"));
			this.widget.render(undefined);
			return;
		}

		if (this.liveTree) {
			this.currentTree = this.liveTree;
			this.widget.setConnectionState('live', localize('hivemindide.agentTree.live', "Live · {0}", this.liveTree.run_id));
			this.widget.render(this.liveTree);
			return;
		}

		const hivemind = this.hivemindTree();
		if (hivemind) {
			this.currentTree = hivemind;
			const count = this.hivemindService.nodes.length;
			const running = this.hivemindService.nodes.filter(n => this.hivemindService.isRunning(n.id)).length;
			this.widget.setConnectionState('live', running
				? localize('hivemindide.agentTree.running', "Hivemind · {0} running", running)
				: localize('hivemindide.agentTree.idle', "Hivemind · idle · {0} {1}", count, count === 1 ? 'node' : 'nodes'));
			this.widget.render(hivemind);
			return;
		}

		this.currentTree = undefined;
		this.widget.setConnectionState('empty', this.hivemindService.folder
			? localize('hivemindide.agentTree.noNodes', "Hivemind · no work recorded yet")
			: localize('hivemindide.agentTree.noHivemind', "No hivemind in this window"));
		this.widget.render(undefined, this.hivemindService.folder
			? localize('hivemindide.agentTree.noNodesHint', "Work shows up here as nodes when you chat in the Chat panel, or when any AI (Claude Code, Codex, Cursor…) records its work in .hivemind/.")
			: localize('hivemindide.agentTree.noHivemindHint', "Open a folder and trust it to give it a .hivemind."));
	}

	/** The project's hivemind nodes as one tree: the project at the root, nodes under their parents. */
	private hivemindTree(): IAgentTree | undefined {
		const nodes = this.hivemindService.nodes;
		const folder = this.hivemindService.folder;
		if (!folder || nodes.length === 0) {
			return undefined;
		}
		const ids = new Set(nodes.map(n => n.id));
		const byParent = new Map<string | undefined, IHivemindNode[]>();
		for (const node of nodes) {
			// A parent that is missing (not pulled yet, or deleted) makes the node top-level.
			const key = node.parent && ids.has(node.parent) ? node.parent : undefined;
			byParent.set(key, [...(byParent.get(key) ?? []), node]);
		}
		const toTreeNode = (node: IHivemindNode): IAgentTreeNode => ({
			id: node.id,
			kind: 'agent',
			author: node.author,
			label: node.title,
			model: node.model ?? node.agent,
			status: node.status === 'paused' ? 'idle' : node.status,
			running: this.hivemindService.isRunning(node.id),
			children: (byParent.get(node.id) ?? []).map(toTreeNode),
		});
		const anyRunning = nodes.some(n => this.hivemindService.isRunning(n.id));
		return {
			run_id: HIVEMIND_RUN_ID,
			root: {
				id: HIVEMIND_ROOT_ID,
				kind: 'root',
				author: basename(dirname(folder)),
				label: localize('hivemindide.agentTree.hivemindRoot', "Hivemind"),
				model: null,
				status: 'active',
				running: anyRunning,
				children: (byParent.get(undefined) ?? []).slice(0, MAX_HIVEMIND_ROOTS).map(toTreeNode),
			},
		};
	}

	/** Keeps an open review in step with the graph when a node starts or stops. */
	private refreshOpenReviews(): void {
		const tree = this.currentTree;
		if (!tree || tree.run_id !== HIVEMIND_RUN_ID) {
			return;
		}
		for (const pane of this.editorService.visibleEditorPanes) {
			if (!(pane instanceof AgentDetailEditor) || !(pane.input instanceof AgentDetailInput)) {
				continue;
			}
			const nodeId = pane.input.detail.nodeId;
			if (nodeId === HIVEMIND_ROOT_ID) {
				const detail = resolveAgentDetail(tree, nodeId);
				if (detail) {
					pane.update(detail);
				}
				continue;
			}
			void this.hivemindDetail(tree, nodeId).then(detail => {
				if (detail && pane.input instanceof AgentDetailInput && pane.input.detail.nodeId === nodeId) {
					pane.update(detail);
				}
			});
		}
	}

	private reconnectStream(): void {
		this.socket.clear();
		this.reconnect.clear();

		if (!this.configurationService.getValue<boolean>(HivemindIDESettings.AgentTreeEnabled)) {
			return;
		}

		const baseUrl = this.configurationService.getValue<string>(HivemindIDESettings.AgentTreeCoordinationUrl)?.trim();
		const repoId = this.configurationService.getValue<string>(HivemindIDESettings.AgentTreeRepoId)?.trim();
		if (!baseUrl || !repoId) {
			return;
		}

		// No "Connecting…" status: when coordinationd is not running this retries
		// every few seconds, and the hivemind graph's status must not flicker.
		// Live frames replace the graph when they arrive.

		const client = new CoordinationClient(baseUrl);
		const url = client.streamUrl(repoId);

		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
		} catch (err) {
			this.widget?.setConnectionState('error', err instanceof Error ? err.message : String(err));
			this.scheduleReconnect();
			return;
		}

		const store = new DisposableStore();
		store.add(toDisposable(() => {
			try { socket.close(); } catch { /* ignore */ }
		}));
		this.socket.value = store;

		socket.onopen = () => {
			if (!this.liveTree) {
				this.refresh();
			}
		};

		socket.onmessage = (msg) => {
			let ev: StreamEvent;
			try {
				ev = JSON.parse(String(msg.data)) as StreamEvent;
			} catch {
				return;
			}

			if (ev.type === 'agent.tree' || ev.type === 'agent.spawned' || ev.type === 'agent.status' || ev.type === 'agent.finished') {
				if (isAgentTree(ev.data)) {
					this.liveTree = ev.data;
					this.refresh();
				} else if (ev.data && typeof ev.data === 'object' && isAgentTree((ev.data as { tree?: unknown }).tree)) {
					this.liveTree = (ev.data as { tree: IAgentTree }).tree;
					this.refresh();
				}
			}
		};

		socket.onerror = () => {
			if (!this.liveTree) {
				this.refresh();
			}
		};

		socket.onclose = () => {
			this.scheduleReconnect();
		};
	}

	private scheduleReconnect(): void {
		const handle = setTimeout(() => this.reconnectStream(), 3000);
		this.reconnect.value = toDisposable(() => clearTimeout(handle));
	}
}

function parseLog(body: string): { title: string; text: string }[] {
	return body.split(/^### +/m).map(part => part.trim()).filter(Boolean).map(part => {
		const nl = part.indexOf('\n');
		if (nl < 0) {
			return { title: part, text: '' };
		}
		return { title: part.slice(0, nl).trim(), text: part.slice(nl + 1).trim() };
	});
}
