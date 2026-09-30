/*---------------------------------------------------------------------------------------------
 *  DOM renderer for the author+AI spawn tree + in-pane detail (no editor tab).
 *--------------------------------------------------------------------------------------------*/

import './media/agentDetail.css';
import { $, append, clearNode, addDisposableListener, EventType, getWindow } from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { IAgentDetail, IAgentTree, IAgentTreeNode } from '../common/agentTree.js';
import { AgentDetailWidget } from './agentDetailWidget.js';

export type AgentTreeConnectionState = 'live' | 'connecting' | 'error' | 'empty';

const MIN_ZOOM = 0.35;
const MAX_ZOOM = 1.5;
/** Card width follows the pane. Below the minimum, siblings stack or the graph zooms out. */
const MIN_CARD = 140;
const MAX_CARD = 320;
const CARD_GAP = 16;
/** Matches the stacked row's left padding, so a column still fits the pane. */
const STACK_PAD = 24;
/** Vertical offset of a stacked card's connector, roughly the middle of its first line. */
const STACK_STUB_Y = 27;

export class AgentTreeWidget extends Disposable {

	private readonly root: HTMLElement;
	private readonly statusEl: HTMLElement;
	private readonly treePane: HTMLElement;
	private readonly scrollEl: HTMLElement;
	private readonly hostEl: HTMLElement;
	private readonly detailWidget: AgentDetailWidget;
	private readonly renderStore = this._register(new DisposableStore());
	private showingDetail = false;
	private readonly zoomLabel: HTMLElement;
	private zoom = 1;
	/** Fit the graph to the pane width until the user zooms by hand. */
	private autoFit = true;

	private readonly _onDidOpenNode = this._register(new Emitter<string>());
	readonly onDidOpenNode: Event<string> = this._onDidOpenNode.event;

	constructor(container: HTMLElement) {
		super();
		this.root = append(container, $('.hivemindide-agent-tree'));
		this.statusEl = append(this.root, $('.hivemindide-agent-tree-status'));
		this.treePane = append(this.root, $('.hivemindide-agent-tree-pane'));
		this.scrollEl = append(this.treePane, $('.hivemindide-agent-tree-scroll'));
		this.hostEl = append(this.scrollEl, $('.hivemindide-agent-tree-host'));
		this.zoomLabel = this.createZoomControls();
		this.registerPanAndZoomGestures();
		this.detailWidget = this._register(new AgentDetailWidget(this.root));
		this._register(this.detailWidget.onDidBack(() => this.showTree()));
		this._register(this.detailWidget.onDidOpenChild(id => this._onDidOpenNode.fire(id)));
	}

	setConnectionState(state: AgentTreeConnectionState, detail?: string): void {
		this.statusEl.className = 'hivemindide-agent-tree-status';
		switch (state) {
			case 'live':
				this.statusEl.classList.add('live');
				this.statusEl.textContent = detail ?? 'Live · coordination stream';
				break;
			case 'connecting':
				this.statusEl.classList.add('muted');
				this.statusEl.textContent = detail ?? 'Connecting…';
				break;
			case 'error':
				this.statusEl.classList.add('error');
				this.statusEl.textContent = detail ?? 'Stream unavailable';
				break;
			case 'empty':
				this.statusEl.classList.add('muted');
				this.statusEl.textContent = detail ?? 'No active agent run';
				break;
		}
	}

	render(tree: IAgentTree | undefined, emptyMessage = 'No agent run to show.'): void {
		if (this.showingDetail) {
			// Keep detail visible; tree host still updates underneath.
		} else {
			this.showTree();
		}
		this.renderStore.clear();
		clearNode(this.hostEl);
		if (!tree) {
			const empty = append(this.hostEl, $('.hivemindide-agent-tree-empty'));
			empty.textContent = emptyMessage;
			return;
		}
		this.hostEl.appendChild(this.buildBranch(tree.root));
		// Connector bars are measured after layout; fit after they are placed.
		getWindow(this.hostEl).requestAnimationFrame(() => {
			if (this.autoFit) {
				this.fit();
			}
		});
	}

	showDetail(detail: IAgentDetail): void {
		this.showingDetail = true;
		this.statusEl.style.display = 'none';
		this.treePane.style.display = 'none';
		this.detailWidget.show(detail);
	}

	showTree(): void {
		this.showingDetail = false;
		this.detailWidget.hide();
		this.statusEl.style.display = '';
		this.treePane.style.display = '';
	}

	layout(_height: number, _width: number): void {
		if (this.autoFit) {
			this.fit();
		}
	}

	// ---- Zoom and pan --------------------------------------------------------------------

	private createZoomControls(): HTMLElement {
		const tools = append(this.treePane, $('.hivemindide-agent-tree-tools'));
		const button = (icon: ThemeIcon | undefined, text: string, title: string, run: () => void) => {
			const el = append(tools, $('button.hivemindide-agent-tree-tool')) as HTMLButtonElement;
			el.type = 'button';
			el.title = title;
			el.setAttribute('aria-label', title);
			if (icon) {
				append(el, $('span')).classList.add(...ThemeIcon.asClassNameArray(icon));
			} else {
				el.textContent = text;
			}
			this._register(addDisposableListener(el, EventType.CLICK, run));
			return el;
		};
		button(Codicon.zoomOut, '', 'Zoom out', () => this.setZoom(this.zoom / 1.2, false));
		const label = button(undefined, '100%', 'Fit to view', () => this.fit());
		button(Codicon.zoomIn, '', 'Zoom in', () => this.setZoom(this.zoom * 1.2, false));
		return label;
	}

	private registerPanAndZoomGestures(): void {
		// Drag the background to pan; cards stay clickable.
		this._register(addDisposableListener(this.scrollEl, EventType.MOUSE_DOWN, (e: MouseEvent) => {
			if (e.button !== 0 || (e.target as HTMLElement).closest('.hivemindide-agent-card, .hivemindide-agent-tree-tools')) {
				return;
			}
			e.preventDefault();
			const start = { x: e.clientX, y: e.clientY, left: this.scrollEl.scrollLeft, top: this.scrollEl.scrollTop };
			this.scrollEl.classList.add('panning');
			const move = addDisposableListener(getWindow(this.scrollEl), EventType.MOUSE_MOVE, (m: MouseEvent) => {
				this.scrollEl.scrollLeft = start.left - (m.clientX - start.x);
				this.scrollEl.scrollTop = start.top - (m.clientY - start.y);
			});
			const up = addDisposableListener(getWindow(this.scrollEl), EventType.MOUSE_UP, () => {
				this.scrollEl.classList.remove('panning');
				move.dispose();
				up.dispose();
			});
		}));
		// Cmd/Ctrl + wheel (and trackpad pinch, which arrives as ctrl+wheel) zooms.
		this._register(addDisposableListener(this.scrollEl, EventType.MOUSE_WHEEL, (e: WheelEvent) => {
			if (!e.ctrlKey && !e.metaKey) {
				return;
			}
			e.preventDefault();
			this.setZoom(this.zoom * Math.exp(-e.deltaY * 0.01), false);
		}, { passive: false }));
	}

	/**
	 * Sizes cards to the pane, stacks a row that would overflow, then zooms so
	 * the whole graph fits the view. Measures at zoom 1 so the connectors,
	 * which are placed in layout pixels, stay aligned after the zoom.
	 */
	private fit(): void {
		this.autoFit = true;
		this.hostEl.style.zoom = '1';
		const availableW = this.scrollEl.clientWidth - 24;
		const availableH = this.scrollEl.clientHeight - 64;
		if (availableW <= 0 || !this.hostEl.querySelector('.hivemindide-agent-card')) {
			this.setZoom(1, true);
			return;
		}

		const rows = Array.from(this.hostEl.querySelectorAll('.hivemindide-agent-children')) as HTMLElement[];
		let widest = 1;
		let anyStacked = false;
		for (const row of rows) {
			const count = row.childElementCount;
			const stack = count > 1 && count * MIN_CARD + (count - 1) * CARD_GAP > availableW;
			row.classList.toggle('stacked', stack);
			anyStacked = anyStacked || stack;
			if (!stack) {
				widest = Math.max(widest, count);
			}
		}

		const raw = widest <= 1
			? availableW - (anyStacked ? STACK_PAD : 0)
			: (availableW - CARD_GAP * (widest - 1)) / widest;
		const card = Math.round(Math.min(MAX_CARD, Math.max(MIN_CARD, raw)));
		this.hostEl.style.setProperty('--hivemindide-card-width', `${card}px`);

		for (const row of rows) {
			this.trimChildBar(row);
		}

		const naturalW = this.hostEl.scrollWidth;
		const naturalH = this.hostEl.scrollHeight;
		const zoomW = naturalW > 0 ? availableW / naturalW : 1;
		const zoomH = naturalH > 0 && availableH > 0 ? availableH / naturalH : 1;
		this.setZoom(Math.min(zoomW, zoomH, 1), true);
	}

	private setZoom(zoom: number, auto: boolean): void {
		this.autoFit = auto;
		this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
		// CSS zoom (unlike transform) changes layout size, so the scroll area stays right.
		this.hostEl.style.zoom = String(this.zoom);
		this.zoomLabel.textContent = `${Math.round(this.zoom * 100)}%`;
		this.zoomLabel.title = auto ? 'Fitted to view' : 'Fit to view';
	}

	private buildBranch(node: IAgentTreeNode): HTMLElement {
		const branch = $('.hivemindide-agent-branch');
		branch.appendChild(this.buildCard(node));

		const kids = node.children;
		if (!kids.length) {
			return branch;
		}

		append(branch, $('.hivemindide-agent-edge'));
		append(branch, $('.hivemindide-agent-junction'));
		append(branch, $('.hivemindide-agent-edge'));

		const row = append(branch, $('.hivemindide-agent-children'));
		for (const child of kids) {
			row.appendChild(this.buildBranch(child));
		}
		return branch;
	}

	private buildCard(node: IAgentTreeNode): HTMLElement {
		const card = $(`.hivemindide-agent-card.${node.kind}`);
		if (node.running) {
			card.classList.add('running');
		}
		card.tabIndex = 0;
		card.setAttribute('role', 'button');
		card.title = 'Open agent detail';

		this.renderStore.add(addDisposableListener(card, EventType.CLICK, () => {
			this._onDidOpenNode.fire(node.id);
		}));
		this.renderStore.add(addDisposableListener(card, EventType.KEY_DOWN, e => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				this._onDidOpenNode.fire(node.id);
			}
		}));

		if (node.author) {
			const author = append(card, $('.hivemindide-agent-author'));
			author.textContent = node.kind === 'root'
				? node.author
				: `${node.author}'s AI`;
		}

		const who = append(card, $('.hivemindide-agent-who'));
		const name = append(who, $('span'));
		name.textContent = node.label;
		name.title = node.label;
		const kindPill = append(who, $(`.hivemindide-agent-pill.kind-${node.kind}`));
		kindPill.textContent = node.kind === 'root' ? 'run' : 'sub';

		if (node.model) {
			const model = append(card, $('.hivemindide-agent-model'));
			model.title = node.model; // the card truncates long model file names
			model.appendChild(document.createTextNode('model '));
			const strong = append(model, $('strong'));
			strong.textContent = node.model;
		}

		const meta = append(card, $('.hivemindide-agent-meta'));
		const running = !!node.running;
		const shown = running ? 'running' : node.status === 'active' ? 'idle' : node.status;
		const status = append(meta, $(`.hivemindide-agent-pill.${running ? 'running' : shown}`));
		status.textContent = shown;

		return card;
	}

	/**
	 * Sizes the connector bar over a row of siblings (or the rail beside a
	 * stack). Uses layout offsets, not client rects, so zoom does not skew it.
	 */
	private trimChildBar(row: HTMLElement): void {
		const branches = Array.from(row.children) as HTMLElement[];
		if (row.classList.contains('stacked')) {
			const last = branches[branches.length - 1];
			row.style.setProperty('--hivemindide-spine', `${last.offsetTop + STACK_STUB_Y}px`);
			return;
		}
		if (branches.length < 2) {
			row.style.setProperty('--hivemindide-bar-left', '50%');
			row.style.setProperty('--hivemindide-bar-right', '50%');
			return;
		}
		const first = branches[0];
		const last = branches[branches.length - 1];
		const left = first.offsetLeft + first.offsetWidth / 2;
		const right = row.clientWidth - (last.offsetLeft + last.offsetWidth / 2);
		row.style.setProperty('--hivemindide-bar-left', `${left}px`);
		row.style.setProperty('--hivemindide-bar-right', `${right}px`);
	}
}
