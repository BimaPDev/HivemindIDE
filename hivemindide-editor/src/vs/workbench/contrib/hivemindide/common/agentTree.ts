/*---------------------------------------------------------------------------------------------
 *  Agent spawn tree — shared types and view IDs.
 *
 *  Root node combines author + parent AI + model. Children are sub-agents.
 *  Clicking a node opens AgentDetailEditor (pipeline · meta · activity · diff).
 *--------------------------------------------------------------------------------------------*/

export const HIVEMINDIDE_VIEWLET_ID = 'workbench.view.hivemindide';
export const HIVEMINDIDE_AGENT_TREE_VIEW_ID = 'workbench.view.hivemindide.agentTree';
/** Opens the review for a graph node in the editor (the wide two-column layout). */
export const HIVEMINDIDE_OPEN_AGENT_NODE_COMMAND = 'hivemindide.agentTree.openNode';
/** Stops the run behind a review: cancels its chat and marks the node killed. */
export const HIVEMINDIDE_KILL_AGENT_NODE_COMMAND = 'hivemindide.agentTree.killNode';
/** Deletes a hivemind node file and removes it from the graph. */
export const HIVEMINDIDE_DELETE_AGENT_NODE_COMMAND = 'hivemindide.agentTree.deleteNode';

export type AgentNodeKind = 'root' | 'agent';
export type AgentNodeStatus = 'active' | 'idle' | 'done';

export type AgentPipelineStage =
	| 'requested'
	| 'provisioning'
	| 'running'
	| 'checking'
	| 'rechecking'
	| 'applying'
	| 'auto-merged';

export const AGENT_PIPELINE_STAGES: readonly AgentPipelineStage[] = [
	'requested',
	'provisioning',
	'running',
	'checking',
	'rechecking',
	'applying',
	'auto-merged',
];

export interface IAgentTreeNode {
	readonly id: string;
	readonly kind: AgentNodeKind;
	/**
	 * Whose AI this is — the human session owner in a shared IDE.
	 * Required on every node (root and nested sub-agents) so teammates can tell
	 * agents apart when several people are running at once.
	 */
	readonly author: string;
	readonly label: string;
	/** Short model name only (sonnet-4, gpt-5). Never a provider URL. */
	readonly model: string | null;
	readonly status: AgentNodeStatus;
	/** The model call for this node is in flight. The card says "running" only then. */
	readonly running?: boolean;
	readonly children: readonly IAgentTreeNode[];
}

export interface IAgentTree {
	readonly run_id: string;
	readonly root: IAgentTreeNode;
}

export interface IAgentDetailMeta {
	readonly from: string;
	readonly createdBy: string;
	readonly paidBy?: string;
	readonly model: string;
	readonly permission?: string;
	readonly base?: string;
	readonly worktree: string;
	readonly changes: string;
}

export interface IAgentActivityItem {
	readonly kind: 'subagent' | 'note';
	/** Bold line above the body. Sub-agent rows use "Subagent" when this is omitted. */
	readonly title?: string;
	readonly text: string;
}

export interface IAgentCheck {
	readonly command: string;
	readonly status: 'pending' | 'passed' | 'failed';
}

export interface IAgentDiffLine {
	readonly type: 'add' | 'del' | 'ctx';
	readonly text: string;
}

export interface IAgentDiffFile {
	readonly path: string;
	readonly lines: readonly IAgentDiffLine[];
}

export interface IAgentDetailFooter {
	readonly text: string;
}

export interface IAgentDetail {
	readonly nodeId: string;
	readonly runId: string;
	/** Name shown in the review header (the person or sub-agent you clicked). */
	readonly title: string;
	/** Editor tab label when it should differ from `title`. */
	readonly tabLabel?: string;
	readonly subtitle: string;
	readonly pipelineStage: AgentPipelineStage;
	/** The run was stopped from the review. The rail says Killed and Kill is hidden. */
	readonly killed?: boolean;
	/** Show Kill. Real hivemind nodes that are still active or paused. */
	readonly canKill?: boolean;
	/** Show Delete. Real hivemind nodes, including ones already killed or done. */
	readonly canDelete?: boolean;
	/** The model is generating for this node right now. */
	readonly running?: boolean;
	readonly meta: IAgentDetailMeta;
	readonly activity: readonly IAgentActivityItem[];
	/** Direct children this agent spawned — for nested drill-down in the detail pane. */
	readonly spawned: readonly IAgentSpawnedChild[];
	readonly checksPinnedBy?: string;
	readonly checks: readonly IAgentCheck[];
	readonly diff?: {
		readonly summary: string;
		readonly file: IAgentDiffFile;
	};
	readonly footers: readonly IAgentDetailFooter[];
}

export interface IAgentSpawnedChild {
	readonly id: string;
	readonly author: string;
	readonly label: string;
	readonly model: string | null;
	readonly status: AgentNodeStatus;
	readonly childCount: number;
}

/** Resolve a detail page for a clicked tree node. */
export function resolveAgentDetail(tree: IAgentTree, nodeId: string): IAgentDetail | undefined {
	const node = findNode(tree.root, nodeId);
	if (!node) {
		return undefined;
	}
	return buildFallbackDetail(tree, node, toSpawned(node));
}

function toSpawned(node: IAgentTreeNode): IAgentSpawnedChild[] {
	return node.children.map(c => ({
		id: c.id,
		author: c.author,
		label: c.label,
		model: c.model,
		status: c.status,
		childCount: countDescendants(c),
	}));
}

function countDescendants(node: IAgentTreeNode): number {
	let n = node.children.length;
	for (const c of node.children) {
		n += countDescendants(c);
	}
	return n;
}

function findNode(node: IAgentTreeNode, id: string): IAgentTreeNode | undefined {
	if (node.id === id) {
		return node;
	}
	for (const child of node.children) {
		const found = findNode(child, id);
		if (found) {
			return found;
		}
	}
	return undefined;
}

function buildFallbackDetail(tree: IAgentTree, node: IAgentTreeNode, spawned: readonly IAgentSpawnedChild[]): IAgentDetail {
	const author = node.author;
	const model = node.model ?? tree.root.model ?? 'unknown';
	const isRoot = node.kind === 'root';
	return {
		nodeId: node.id,
		runId: tree.run_id,
		title: isRoot ? author : node.label,
		tabLabel: node.label,
		subtitle: isRoot
			? 'Spawned from the composer.'
			: `Spawned from ${tree.root.author}'s ${tree.root.label}.`,
		pipelineStage: node.running ? 'running' : node.status === 'idle' ? 'provisioning' : 'checking',
		running: node.running,
		meta: {
			from: isRoot ? 'the composer' : tree.root.label,
			createdBy: author,
			model,
			permission: 'Request (inherited)',
			base: 'rev —',
			worktree: isRoot ? 'parent' : `child/${node.label.toLowerCase()}`,
			changes: '—',
		},
		activity: [],
		spawned,
		checks: [],
		footers: [
			{ text: node.status === 'done' ? 'waiting for a human to review' : 'in progress' },
			{ text: 'parent workspace unchanged' },
		],
	};
}

/** Review page for a `.hivemind` node opened from the graph. */
export interface IHivemindReviewSource {
	readonly id: string;
	readonly title: string;
	readonly author: string;
	readonly agent: string;
	readonly model: string | null;
	readonly status: AgentNodeStatus;
	readonly goal: string;
	readonly handoff: string;
	readonly files: readonly string[];
	readonly killed?: boolean;
	readonly running?: boolean;
	readonly parentTitle?: string;
	readonly log: readonly { readonly title: string; readonly text: string }[];
	readonly spawned: readonly IAgentSpawnedChild[];
}

export function detailFromHivemind(source: IHivemindReviewSource): IAgentDetail {
	const model = source.model ?? source.agent;
	const fileCount = source.files.length;
	const activity: IAgentActivityItem[] = [];
	if (source.handoff) {
		activity.push({ kind: 'note', title: 'Handoff', text: source.handoff });
	}
	if (source.goal) {
		activity.push({ kind: 'note', title: 'Goal', text: source.goal });
	}
	for (const entry of source.log) {
		activity.push({ kind: 'note', title: entry.title, text: entry.text });
	}
	return {
		nodeId: source.id,
		runId: 'hivemind',
		title: source.author,
		tabLabel: source.title,
		subtitle: source.parentTitle
			? `Spawned from ${source.parentTitle}.`
			: `Recorded by ${source.agent}.`,
		// A finished turn stays `active` on disk. Only a live generation is Running;
		// once it stops, the review is waiting on a person.
		pipelineStage: source.running ? 'running' : source.status === 'idle' ? 'running' : 'checking',
		killed: source.killed,
		running: source.running,
		canKill: !source.killed && source.status !== 'done',
		canDelete: true,
		meta: {
			from: source.parentTitle ?? source.agent,
			createdBy: source.author,
			model,
			worktree: `nodes/${source.id}`,
			changes: fileCount === 0 ? '—' : fileCount === 1 ? '1 file' : `${fileCount} files`,
		},
		activity,
		spawned: source.spawned,
		checks: [],
		footers: [
			{ text: source.killed ? 'killed' : source.running ? 'running' : source.status === 'idle' ? 'not running' : 'waiting for a human to review' },
			{ text: 'parent workspace unchanged' },
		],
	};
}

export function isAgentTree(value: unknown): value is IAgentTree {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const v = value as Record<string, unknown>;
	return typeof v.run_id === 'string' && isAgentTreeNode(v.root);
}

function isAgentTreeNode(value: unknown): value is IAgentTreeNode {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const v = value as Record<string, unknown>;
	return (v.kind === 'root' || v.kind === 'agent')
		&& typeof v.id === 'string'
		&& typeof v.author === 'string'
		&& typeof v.label === 'string'
		&& Array.isArray(v.children);
}

export function pipelineStageLabel(stage: AgentPipelineStage): string {
	switch (stage) {
		case 'requested': return 'Requested';
		case 'provisioning': return 'Provisioning';
		case 'running': return 'Running';
		case 'checking': return 'Checking';
		case 'rechecking': return 'Rechecking';
		case 'applying': return 'Applying';
		case 'auto-merged': return 'Auto-merged';
	}
}
