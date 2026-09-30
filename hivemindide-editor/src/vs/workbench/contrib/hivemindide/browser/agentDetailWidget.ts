/*---------------------------------------------------------------------------------------------
 *  Shared agent detail body (pipeline · meta · activity · checks · diff).
 *  Used in the editor when a graph node is clicked. The sidebar can host the
 *  same body with a back button.
 *--------------------------------------------------------------------------------------------*/

import { $, append, clearNode, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import {
	AgentPipelineStage,
	IAgentDetail,
	pipelineStageLabel,
} from '../common/agentTree.js';

/** The review rail from the run inspector: five steps, current one open. */
const REVIEW_STEPS = ['Requested', 'Provisioning', 'Running', 'Reviewing', 'Review required'] as const;

export interface IAgentDetailWidgetOptions {
	/** Sidebar hosts a back control. The editor does not. */
	readonly showBack?: boolean;
	readonly sidebar?: boolean;
}

export class AgentDetailWidget extends Disposable {

	private readonly root: HTMLElement;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly showBack: boolean;

	private readonly _onDidBack = this._register(new Emitter<void>());
	readonly onDidBack: Event<void> = this._onDidBack.event;

	private readonly _onDidOpenChild = this._register(new Emitter<string>());
	readonly onDidOpenChild: Event<string> = this._onDidOpenChild.event;

	private readonly _onDidKill = this._register(new Emitter<void>());
	readonly onDidKill: Event<void> = this._onDidKill.event;

	private readonly _onDidDelete = this._register(new Emitter<void>());
	readonly onDidDelete: Event<void> = this._onDidDelete.event;

	constructor(container: HTMLElement, options: IAgentDetailWidgetOptions = {}) {
		super();
		this.showBack = options.showBack !== false;
		const sidebar = options.sidebar !== false && this.showBack;
		this.root = append(container, $(sidebar
			? '.hivemindide-agent-detail-body.hivemindide-agent-detail-sidebar'
			: '.hivemindide-agent-detail-body'));
		this.root.style.display = 'none';
	}

	get domNode(): HTMLElement {
		return this.root;
	}

	show(detail: IAgentDetail): void {
		this.root.style.display = '';
		this.render(detail);
	}

	hide(): void {
		this.root.style.display = 'none';
		this.renderStore.clear();
		clearNode(this.root);
	}

	private render(detail: IAgentDetail): void {
		this.renderStore.clear();
		clearNode(this.root);

		if (this.showBack) {
			const back = append(this.root, $('button.hivemindide-agent-detail-back')) as HTMLButtonElement;
			back.type = 'button';
			back.textContent = localize('hivemindide.agentDetail.back', "← Agents");
			this.renderStore.add(addDisposableListener(back, EventType.CLICK, () => this._onDidBack.fire()));
		}

		const layout = append(this.root, $('.hivemindide-agent-detail-layout'));
		layout.appendChild(this.buildRail(detail));
		layout.appendChild(this.buildMain(detail));
	}

	private buildRail(detail: IAgentDetail): HTMLElement {
		const rail = $('.hivemindide-agent-detail-rail');
		const step = reviewStep(detail);

		const stageHead = append(rail, $('.hivemindide-agent-detail-stage-head'));
		const stageTitle = append(stageHead, $('.hivemindide-agent-detail-stage-title'));
		icon(stageTitle, step.mode === 'past' ? Codicon.check : Codicon.circleLargeOutline);
		const stageLabel = append(stageTitle, $('span'));
		stageLabel.textContent = step.title;
		const stageSub = append(stageHead, $('.hivemindide-agent-detail-stage-sub'));
		stageSub.textContent = step.subtitle;

		const stepper = append(rail, $('.hivemindide-agent-detail-stepper'));
		REVIEW_STEPS.forEach((label, i) => {
			const row = append(stepper, $('.hivemindide-agent-detail-step'));
			const done = step.mode === 'past' || i < step.index;
			const current = step.mode === 'current' && i === step.index;
			if (current) {
				row.classList.add('current');
			} else if (done) {
				row.classList.add('done');
			} else {
				row.classList.add('future');
			}
			const mark = append(row, $('.hivemindide-agent-detail-step-mark'));
			icon(mark, done && !current ? Codicon.check : Codicon.circleLargeOutline);
			const text = append(row, $('span'));
			text.textContent = label;
		});

		const meta = append(rail, $('.hivemindide-agent-detail-meta'));
		const rows: { key: string; value: string | undefined; icon: ThemeIcon; mono?: boolean }[] = [
			{ key: localize('hivemindide.agentDetail.from', "From"), value: detail.meta.from, icon: Codicon.inbox },
			{ key: localize('hivemindide.agentDetail.createdBy', "Created by"), value: detail.meta.createdBy, icon: Codicon.account },
			{ key: localize('hivemindide.agentDetail.paidBy', "Paid by"), value: detail.meta.paidBy, icon: Codicon.creditCard },
			{ key: localize('hivemindide.agentDetail.model', "Model"), value: detail.meta.model, icon: Codicon.chip, mono: true },
			{ key: localize('hivemindide.agentDetail.permission', "Permission"), value: detail.meta.permission, icon: Codicon.shield },
			{ key: localize('hivemindide.agentDetail.base', "Base"), value: detail.meta.base, icon: Codicon.gitCommit },
			{ key: localize('hivemindide.agentDetail.worktree', "Worktree"), value: detail.meta.worktree, icon: Codicon.gitBranch, mono: true },
			{ key: localize('hivemindide.agentDetail.changes', "Changes"), value: detail.meta.changes, icon: Codicon.diff },
		];
		for (const rowData of rows) {
			if (!rowData.value) {
				continue;
			}
			const row = append(meta, $('.hivemindide-agent-detail-meta-row'));
			const k = append(row, $('.hivemindide-agent-detail-meta-key'));
			icon(k, rowData.icon);
			const keyLabel = append(k, $('span'));
			keyLabel.textContent = rowData.key;
			const v = append(row, $('.hivemindide-agent-detail-meta-val'));
			v.textContent = rowData.value;
			if (rowData.mono) {
				v.classList.add('mono');
			}
		}

		if (detail.canKill || detail.canDelete) {
			const actions = append(rail, $('.hivemindide-agent-detail-actions'));
			if (detail.canKill) {
				const kill = append(actions, $('button.hivemindide-agent-detail-kill')) as HTMLButtonElement;
				kill.type = 'button';
				icon(kill, Codicon.debugStop);
				const killLabel = append(kill, $('span'));
				killLabel.textContent = localize('hivemindide.agentDetail.kill', "Kill");
				this.renderStore.add(addDisposableListener(kill, EventType.CLICK, () => {
					kill.disabled = true;
					this._onDidKill.fire();
				}));
			}
			if (detail.canDelete) {
				const del = append(actions, $('button.hivemindide-agent-detail-delete')) as HTMLButtonElement;
				del.type = 'button';
				icon(del, Codicon.trash);
				const delLabel = append(del, $('span'));
				delLabel.textContent = localize('hivemindide.agentDetail.delete', "Delete");
				this.renderStore.add(addDisposableListener(del, EventType.CLICK, () => {
					del.disabled = true;
					this._onDidDelete.fire();
				}));
			}
		}

		return rail;
	}

	private buildMain(detail: IAgentDetail): HTMLElement {
		const main = $('.hivemindide-agent-detail-main');

		const header = append(main, $('.hivemindide-agent-detail-header'));
		const avatar = append(header, $('.hivemindide-agent-detail-avatar'));
		icon(avatar, Codicon.account);
		const heading = append(header, $('.hivemindide-agent-detail-heading'));
		const badge = append(heading, $('.hivemindide-agent-detail-badge'));
		badge.textContent = detail.title;
		const sub = append(heading, $('.hivemindide-agent-detail-subtitle'));
		sub.textContent = detail.subtitle;

		if (detail.activity.length || detail.spawned.length) {
			const list = append(main, $('.hivemindide-agent-detail-activity'));
			for (const item of detail.activity) {
				const row = append(list, $('.hivemindide-agent-detail-activity-row'));
				const glyph = append(row, $('.hivemindide-agent-detail-activity-icon'));
				icon(glyph, item.kind === 'subagent' ? Codicon.organization : Codicon.comment);
				const body = append(row, $('.hivemindide-agent-detail-activity-body'));
				const title = item.title ?? (item.kind === 'subagent'
					? localize('hivemindide.agentDetail.subagent', "Subagent")
					: '');
				if (title) {
					const tag = append(body, $('.hivemindide-agent-detail-activity-title'));
					tag.textContent = title;
				}
				if (item.text) {
					const text = append(body, $('.hivemindide-agent-detail-activity-text'));
					text.textContent = item.text;
				}
			}
			for (const child of detail.spawned) {
				const row = append(list, $('button.hivemindide-agent-detail-activity-row.hivemindide-agent-detail-spawned-row')) as HTMLButtonElement;
				row.type = 'button';
				const glyph = append(row, $('.hivemindide-agent-detail-activity-icon'));
				icon(glyph, Codicon.organization);
				const body = append(row, $('.hivemindide-agent-detail-activity-body'));
				const tag = append(body, $('.hivemindide-agent-detail-activity-title'));
				tag.textContent = localize('hivemindide.agentDetail.subagent', "Subagent");
				const text = append(body, $('.hivemindide-agent-detail-activity-text'));
				const bits = [
					`${child.author}'s ${child.label}`,
					child.model ?? undefined,
					child.status,
					child.childCount > 0 ? localize('hivemindide.agentDetail.nestedCount', "{0} nested", child.childCount) : undefined,
				].filter(Boolean);
				text.textContent = bits.join(' · ');
				this.renderStore.add(addDisposableListener(row, EventType.CLICK, () => {
					this._onDidOpenChild.fire(child.id);
				}));
			}
		}

		if (detail.checks.length) {
			const checks = append(main, $('.hivemindide-agent-detail-checks'));
			const title = append(checks, $('.hivemindide-agent-detail-section-title'));
			icon(title, Codicon.check);
			const titleText = append(title, $('span.hivemindide-agent-detail-section-label'));
			titleText.textContent = localize('hivemindide.agentDetail.checks', "Checks");
			if (detail.checksPinnedBy) {
				const pinned = append(title, $('span.hivemindide-agent-detail-section-muted'));
				pinned.textContent = localize('hivemindide.agentDetail.checksPinned', "pinned by the {0}", detail.checksPinnedBy);
			}
			const card = append(checks, $('.hivemindide-agent-detail-checks-card'));
			for (const check of detail.checks) {
				const row = append(card, $('.hivemindide-agent-detail-check-row'));
				const mark = append(row, $('.hivemindide-agent-detail-check-icon'));
				icon(mark, check.status === 'passed' ? Codicon.pass : check.status === 'failed' ? Codicon.error : Codicon.circleLargeOutline);
				const cmd = append(row, $('code'));
				cmd.textContent = check.command;
				const status = append(row, $(`.hivemindide-agent-detail-check-status.${check.status}`));
				status.textContent = check.status;
			}
		}

		if (detail.diff) {
			const diff = append(main, $('.hivemindide-agent-detail-diff'));
			const title = append(diff, $('.hivemindide-agent-detail-section-title'));
			icon(title, Codicon.diff);
			const titleText = append(title, $('span.hivemindide-agent-detail-section-label'));
			titleText.textContent = localize('hivemindide.agentDetail.candidateDiff', "Candidate diff");
			appendDiffSummary(title, detail.diff.summary);

			const file = append(diff, $('.hivemindide-agent-detail-diff-file'));
			const path = append(file, $('.hivemindide-agent-detail-diff-path'));
			icon(path, Codicon.file);
			const pathText = append(path, $('span'));
			pathText.textContent = detail.diff.file.path;
			const code = append(file, $('.hivemindide-agent-detail-diff-code'));
			detail.diff.file.lines.forEach((line, index) => {
				const row = append(code, $(`.hivemindide-agent-detail-diff-line.${line.type}`));
				const ln = append(row, $('span.ln'));
				ln.textContent = String(index + 1);
				const prefix = append(row, $('span.prefix'));
				prefix.textContent = line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' ';
				const text = append(row, $('span.text'));
				text.textContent = line.text;
			});
		}

		if (detail.footers.length) {
			const foot = append(main, $('.hivemindide-agent-detail-footers'));
			for (const f of detail.footers) {
				const pill = append(foot, $('.hivemindide-agent-detail-footer-pill'));
				const waiting = /wait|progress/i.test(f.text) || f.text === 'running';
				icon(pill, waiting ? Codicon.watch : Codicon.circleLargeOutline);
				const label = append(pill, $('span'));
				label.textContent = f.text;
			}
		}

		return main;
	}
}

interface IReviewStep {
	readonly index: number;
	readonly mode: 'current' | 'past' | 'idle';
	readonly title: string;
	readonly subtitle: string;
}

function reviewStep(detail: IAgentDetail): IReviewStep {
	if (detail.killed) {
		return {
			index: REVIEW_STEPS.length - 1,
			mode: 'past',
			title: localize('hivemindide.agentDetail.killed', "Killed"),
			subtitle: localize('hivemindide.agentDetail.killedSub', "This run was stopped."),
		};
	}
	switch (detail.pipelineStage) {
		case 'requested':
			return { index: 0, mode: 'current', title: REVIEW_STEPS[0], subtitle: stageSubtitle('requested') };
		case 'provisioning':
			return { index: 1, mode: 'current', title: REVIEW_STEPS[1], subtitle: stageSubtitle('provisioning') };
		case 'running':
			if (!detail.running) {
				return {
					index: 2,
					mode: 'idle',
					title: localize('hivemindide.agentDetail.idle', "Idle"),
					subtitle: localize('hivemindide.agentDetail.idleSub', "Not running."),
				};
			}
			return { index: 2, mode: 'current', title: REVIEW_STEPS[2], subtitle: stageSubtitle('running') };
		case 'checking':
		case 'rechecking': {
			const open = detail.checks.some(c => c.status === 'pending' || c.status === 'failed');
			if (open) {
				return { index: 3, mode: 'current', title: REVIEW_STEPS[3], subtitle: stageSubtitle(detail.pipelineStage) };
			}
			return {
				index: 4,
				mode: 'current',
				title: REVIEW_STEPS[4],
				subtitle: detail.checks.length === 0
					? localize('hivemindide.agentDetail.noChecks', "No required checks are configured, so nothing merged automatically.")
					: localize('hivemindide.agentDetail.reviewRequired', "Waiting for a human to review."),
			};
		}
		case 'applying':
			return { index: 4, mode: 'past', title: pipelineStageLabel('applying'), subtitle: stageSubtitle('applying') };
		case 'auto-merged':
			return { index: 4, mode: 'past', title: pipelineStageLabel('auto-merged'), subtitle: stageSubtitle('auto-merged') };
	}
}

function stageSubtitle(stage: AgentPipelineStage): string {
	switch (stage) {
		case 'requested': return localize('hivemindide.agentDetail.waitingProvision', "Waiting to provision.");
		case 'provisioning': return localize('hivemindide.agentDetail.provisioning', "Setting up the worktree.");
		case 'running': return localize('hivemindide.agentDetail.running', "Agent is working.");
		case 'checking': return localize('hivemindide.agentDetail.checking', "Running pinned checks.");
		case 'rechecking': return localize('hivemindide.agentDetail.rechecking', "Re-running checks.");
		case 'applying': return localize('hivemindide.agentDetail.applying', "Applying to the parent.");
		case 'auto-merged': return localize('hivemindide.agentDetail.merged', "Merged into the parent.");
	}
}

function icon(parent: HTMLElement, themeIcon: ThemeIcon): HTMLElement {
	const el = append(parent, $('span.hivemindide-agent-detail-icon'));
	el.classList.add(...ThemeIcon.asClassNameArray(themeIcon));
	return el;
}

/** Colors `+N` and `-N` inside a diff summary such as `+96 −12 · rev 44`. */
function appendDiffSummary(parent: HTMLElement, summary: string): void {
	const wrap = append(parent, $('span.hivemindide-agent-detail-diff-summary'));
	const re = /([+][\d,]+)|([-−][\d,]+)/g;
	let cursor = 0;
	for (const match of summary.matchAll(re)) {
		const index = match.index ?? 0;
		if (index > cursor) {
			wrap.appendChild(document.createTextNode(summary.slice(cursor, index)));
		}
		const token = match[0];
		const span = append(wrap, $(token.startsWith('+') ? 'span.add' : 'span.del'));
		span.textContent = token;
		cursor = index + token.length;
	}
	if (cursor < summary.length) {
		wrap.appendChild(document.createTextNode(summary.slice(cursor)));
	}
}
