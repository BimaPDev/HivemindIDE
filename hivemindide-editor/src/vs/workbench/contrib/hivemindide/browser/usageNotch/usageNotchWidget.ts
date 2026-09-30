/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The usage notch: a black notch on a window edge with one ring per assistant.
 *  A ring fills with the share of the plan limit closest to running out and
 *  takes its color from how close that is; hovering it shows every limit
 *  window with its reset time.
 *
 *  The user drags it anywhere; on release it snaps to the nearest edge and the
 *  spot is remembered. Rings are keyed by provider and updated in place, so a
 *  refresh while a card is open does not tear the card down.
 *--------------------------------------------------------------------------------------------*/

import './media/usageNotch.css';
import { $, addDisposableListener, append, EventType, getWindow } from '../../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../../base/browser/keyboardEvent.js';
import { StandardMouseEvent } from '../../../../../base/browser/mouseEvent.js';
import { HoverPosition } from '../../../../../base/browser/ui/hover/hoverWidget.js';
import { toAction } from '../../../../../base/common/actions.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { fromNow } from '../../../../../base/common/date.js';
import { KeyCode } from '../../../../../base/common/keyCodes.js';
import { Disposable, DisposableMap, DisposableStore, IDisposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { language } from '../../../../../base/common/platform.js';
import { localize } from '../../../../../nls.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../../platform/hover/browser/hover.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { HivemindIDESettings } from '../../common/hivemindideConfiguration.js';
import { effectivePercent, formatPercent, formatResets, headlineWindow, IProviderLimits, IUsageWindow, liveWindows, severityOf, UsageSeverity, worstSeverity } from '../../common/usageLimits.js';
import { INotchPlacement, isVerticalEdge, notchStart, parseNotchPlacement, snapNotchPlacement } from '../../common/usageNotchPlacement.js';
import { UsageLimitsModel } from './usageLimitsModel.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const RING_RADIUS = 18;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
/** Long enough to cross the gap between the pill and the panel without it folding. */
const COLLAPSE_DELAY_MS = 400;
/** Less than this is a click, not a drag. */
const DRAG_THRESHOLD_PX = 4;
/** Room kept at each end of an edge for the notch's shoulders. */
const SHOULDER_MARGIN_PX = 44;
const PLACEMENT_STORAGE_KEY = 'hivemindide.usageNotch.placement';

interface IRing {
	readonly element: HTMLElement;
	readonly value: SVGCircleElement;
	readonly glyph: HTMLElement;
	readonly percent: HTMLElement;
}

/** The card opens away from the edge the notch is on. */
const HOVER_POSITION = { left: HoverPosition.RIGHT, right: HoverPosition.LEFT, top: HoverPosition.BELOW, bottom: HoverPosition.ABOVE } as const;

interface IDrag {
	readonly pointerId: number;
	readonly startX: number;
	readonly startY: number;
	/** Where in the notch it was grabbed, so it does not jump under the pointer. */
	readonly grabX: number;
	readonly grabY: number;
	moved: boolean;
}

export class UsageNotchWidget extends Disposable {

	private readonly root: HTMLElement;
	private readonly pill: HTMLElement;
	private readonly panel: HTMLElement;
	private readonly rings = this._register(new DisposableMap<string, IDisposable>());
	private readonly ringElements = new Map<string, IRing>();
	private providers = new Map<string, IProviderLimits>();
	private pointerInside = false;
	private placement: INotchPlacement;
	private drag: IDrag | undefined;
	/** Window-wide, from press to release: a quick flick leaves the notch before it counts as a drag. */
	private readonly dragListeners = this._register(new MutableDisposable<DisposableStore>());
	private readonly collapse = this._register(new RunOnceScheduler(() => this.setExpanded(false), COLLAPSE_DELAY_MS));

	constructor(
		private readonly model: UsageLimitsModel,
		@ILayoutService private readonly layoutService: ILayoutService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IHoverService private readonly hoverService: IHoverService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IStorageService private readonly storageService: IStorageService,
	) {
		super();
		this.placement = parseNotchPlacement(this.storageService.get(PLACEMENT_STORAGE_KEY, StorageScope.APPLICATION));

		this.root = append(layoutService.mainContainer, $('.hivemindide-usage-notch'));
		this._register({ dispose: () => this.root.remove() });

		this.pill = append(this.root, $('.hivemindide-usage-notch-pill', { role: 'button', tabIndex: 0 }));
		this.pill.setAttribute('aria-label', localize('usageNotch.pill', "AI usage limits"));
		this.panel = append(this.root, $('.hivemindide-usage-notch-panel', { role: 'list' }));
		this.panel.setAttribute('aria-label', localize('usageNotch.panel', "AI usage limits"));

		this._register(addDisposableListener(this.root, EventType.MOUSE_ENTER, () => {
			this.pointerInside = true;
			this.collapse.cancel();
			this.setExpanded(true);
		}));
		this._register(addDisposableListener(this.root, EventType.MOUSE_LEAVE, () => {
			this.pointerInside = false;
			this.collapse.schedule();
		}));
		this._register(addDisposableListener(this.pill, EventType.KEY_DOWN, e => {
			const event = new StandardKeyboardEvent(e);
			if (event.equals(KeyCode.Enter) || event.equals(KeyCode.Space)) {
				event.preventDefault();
				this.setExpanded(true);
				(this.panel.firstElementChild as HTMLElement | null)?.focus();
			}
		}));
		this._register(addDisposableListener(this.root, EventType.FOCUS_OUT, e => {
			if (!this.root.contains(e.relatedTarget as Node | null) && !this.pointerInside) {
				this.collapse.schedule();
			}
		}));
		this._register(addDisposableListener(this.root, EventType.CONTEXT_MENU, e => {
			e.preventDefault();
			this.showContextMenu(e);
		}));
		this._register(addDisposableListener(this.root, EventType.POINTER_DOWN, e => this.onPointerDown(e)));

		this._register(this.layoutService.onDidLayoutMainContainer(() => this.applyPlacement()));
		// Moved in another window: every window keeps the notch in the same spot.
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, PLACEMENT_STORAGE_KEY, this._store)(e => {
			if (e.external) {
				this.placement = parseNotchPlacement(this.storageService.get(PLACEMENT_STORAGE_KEY, StorageScope.APPLICATION));
				this.render();
			}
		}));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(HivemindIDESettings.UsageNotchKeepOpen)) {
				this.render();
			}
		}));
		this._register(this.model.onDidChange(() => this.render()));
		this.render();
	}


	private get keepOpen(): boolean {
		return !!this.configurationService.getValue<boolean>(HivemindIDESettings.UsageNotchKeepOpen);
	}

	/** Hidden while the MacBook notch shows the same rings. */
	setSuppressed(suppressed: boolean): void {
		this.root.style.display = suppressed ? 'none' : '';
		if (!suppressed) {
			this.applyPlacement();
		}
	}

	private setExpanded(expanded: boolean): void {
		this.root.classList.toggle('expanded', expanded || this.keepOpen);
		this.applyPlacement(); // the pill and the panel differ in length
	}

	// ---- Placement and dragging ------------------------------------------------

	/** Pins the notch to its edge, `offset` of the way along, whole and inside the window. */
	private applyPlacement(): void {
		if (this.drag?.moved) {
			return;
		}
		const { edge } = this.placement;
		const { width, height } = this.layoutService.mainContainerDimension;
		const vertical = isVerticalEdge(edge);
		const start = notchStart(this.placement, vertical ? height : width, vertical ? this.root.offsetHeight : this.root.offsetWidth, SHOULDER_MARGIN_PX);
		this.setPosition(
			edge === 'left' ? 0 : vertical ? undefined : start,
			edge === 'top' ? 0 : vertical ? start : undefined,
			edge === 'right' ? 0 : undefined,
			edge === 'bottom' ? 0 : undefined,
		);
	}

	private setPosition(left: number | undefined, top: number | undefined, right?: number, bottom?: number): void {
		const px = (value: number | undefined) => value === undefined ? '' : `${Math.round(value)}px`;
		this.root.style.left = px(left);
		this.root.style.top = px(top);
		this.root.style.right = px(right);
		this.root.style.bottom = px(bottom);
	}

	private onPointerDown(e: PointerEvent): void {
		if (e.button !== 0) {
			return;
		}
		const rect = this.root.getBoundingClientRect();
		this.drag = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, grabX: e.clientX - rect.left, grabY: e.clientY - rect.top, moved: false };
		const targetWindow = getWindow(this.root);
		const listeners = new DisposableStore();
		listeners.add(addDisposableListener(targetWindow, EventType.POINTER_MOVE, event => this.onPointerMove(event)));
		listeners.add(addDisposableListener(targetWindow, EventType.POINTER_UP, event => this.onPointerUp(event)));
		listeners.add(addDisposableListener(targetWindow, 'pointercancel', () => this.cancelDrag()));
		this.dragListeners.value = listeners;
	}

	private onPointerMove(e: PointerEvent): void {
		const drag = this.drag;
		if (!drag || e.pointerId !== drag.pointerId) {
			return;
		}
		if (!drag.moved) {
			if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < DRAG_THRESHOLD_PX) {
				return;
			}
			drag.moved = true;
			this.root.setPointerCapture(e.pointerId);
			this.root.classList.add('dragging');
		}
		// A ring's card would otherwise open under the pointer mid-drag.
		this.hoverService.hideHover(true);
		const container = this.layoutService.mainContainer.getBoundingClientRect();
		this.setPosition(e.clientX - container.left - drag.grabX, e.clientY - container.top - drag.grabY);
	}

	private onPointerUp(e: PointerEvent): void {
		const drag = this.drag;
		if (!drag || e.pointerId !== drag.pointerId) {
			return;
		}
		this.drag = undefined;
		this.dragListeners.clear();
		if (!drag.moved) {
			return;
		}
		this.root.classList.remove('dragging');
		const container = this.layoutService.mainContainer.getBoundingClientRect();
		this.placement = snapNotchPlacement(e.clientX - container.left, e.clientY - container.top, container.width, container.height);
		this.storageService.store(PLACEMENT_STORAGE_KEY, JSON.stringify(this.placement), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this.render();
	}

	private cancelDrag(): void {
		const moved = this.drag?.moved;
		this.drag = undefined;
		this.dragListeners.clear();
		if (moved) {
			this.root.classList.remove('dragging');
			this.applyPlacement();
		}
	}

	private resetPlacement(): void {
		this.storageService.remove(PLACEMENT_STORAGE_KEY, StorageScope.APPLICATION);
		this.placement = parseNotchPlacement(undefined);
		this.render();
	}

	private render(): void {
		const now = Date.now();
		const providers = this.model.providers;
		this.providers = new Map(providers.map(p => [p.id, p]));

		for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
			this.root.classList.toggle(`edge-${edge}`, this.placement.edge === edge);
		}
		this.root.classList.toggle('horizontal', !isVerticalEdge(this.placement.edge));
		this.setExpanded(this.pointerInside || this.root.contains(this.root.ownerDocument.activeElement));

		for (const id of [...this.ringElements.keys()]) {
			if (!this.providers.has(id)) {
				this.ringElements.get(id)!.element.remove();
				this.ringElements.delete(id);
				this.rings.deleteAndDispose(id);
			}
		}

		const severities: UsageSeverity[] = [];
		for (const provider of providers) {
			const ring = this.ringElements.get(provider.id) ?? this.createRing(provider.id);
			this.panel.appendChild(ring.element); // keeps the model's order
			const limit = headlineWindow(provider, now);
			const percent = limit && effectivePercent(limit);
			const severity = severityOf(percent);
			severities.push(severity);

			ring.element.className = `hivemindide-usage-ring severity-${severity}`;
			ring.element.classList.toggle('exhausted', !!limit?.exhausted || (percent ?? 0) >= 100);
			ring.value.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - (percent ?? 0) / 100));
			ring.glyph.textContent = provider.glyph;
			ring.percent.textContent = formatPercent(percent);
			ring.element.setAttribute('aria-label', limit
				? localize('usageNotch.ring.aria', "{0}: {1} used of {2}", provider.label, formatPercent(percent), limit.label)
				: provider.observedAt === undefined
					? localize('usageNotch.ring.ariaNone', "{0}: no reading yet", provider.label)
					: localize('usageNotch.ring.ariaReset', "{0}: limits have reset since the last reading", provider.label));
		}

		const worst = worstSeverity(severities);
		this.root.dataset.severity = worst;
		this.root.classList.toggle('alerting', worst === UsageSeverity.Critical);
		this.applyPlacement();
	}

	private createRing(id: string): IRing {
		const element = $('.hivemindide-usage-ring', { role: 'listitem', tabIndex: 0 });
		const doc = this.root.ownerDocument;
		const svg = doc.createElementNS(SVG_NS, 'svg');
		svg.setAttribute('viewBox', '0 0 44 44');
		svg.setAttribute('aria-hidden', 'true');
		const track = doc.createElementNS(SVG_NS, 'circle');
		const value = doc.createElementNS(SVG_NS, 'circle');
		for (const [circle, cls] of [[track, 'track'], [value, 'value']] as const) {
			circle.setAttribute('class', cls);
			circle.setAttribute('cx', '22');
			circle.setAttribute('cy', '22');
			circle.setAttribute('r', String(RING_RADIUS));
			svg.appendChild(circle);
		}
		value.style.strokeDasharray = String(RING_CIRCUMFERENCE);
		const dial = append(element, $('.hivemindide-usage-ring-dial'));
		dial.appendChild(svg);
		const glyph = append(dial, $('span.hivemindide-usage-ring-glyph'));
		const percent = append(element, $('span.hivemindide-usage-ring-percent'));

		const store = new DisposableStore();
		store.add(this.hoverService.setupDelayedHover(element, () => ({
			content: this.renderCard(id),
			additionalClasses: ['hivemindide-usage-card'],
			position: { hoverPosition: HOVER_POSITION[this.placement.edge] },
			appearance: { showPointer: true },
		})));
		this.rings.set(id, store);

		const ring = { element, value, glyph, percent };
		this.ringElements.set(id, ring);
		return ring;
	}

	/** The card beside a ring: every live limit window as a bar, as Claude's own usage page lays it out. */
	private renderCard(id: string): HTMLElement {
		const card = $('.hivemindide-usage-card-body');
		const provider = this.providers.get(id);
		if (!provider) {
			return card;
		}
		const now = Date.now();

		const title = append(card, $('.hivemindide-usage-card-title'));
		append(title, $('span.hivemindide-usage-card-glyph')).textContent = provider.glyph;
		append(title, $('span')).textContent = provider.label;

		const windows = liveWindows(provider, now);
		if (windows.length === 0 && provider.observedAt !== undefined) {
			append(card, $('.hivemindide-usage-card-note')).textContent = localize('usageNotch.card.allReset', "Every limit has reset since the last reading. The ring fills again the next time {0} reports.", provider.label);
		}
		for (const limit of windows) {
			this.renderWindow(append(card, $('.hivemindide-usage-card-window')), limit, now);
		}

		const footer = append(card, $('.hivemindide-usage-card-footer'));
		footer.textContent = provider.observedAt === undefined
			? provider.source
			: localize('usageNotch.card.footer', "{0} · {1}", provider.source, fromNow(provider.observedAt, true));
		return card;
	}

	private renderWindow(row: HTMLElement, limit: IUsageWindow, now: number): void {
		const percent = effectivePercent(limit);
		const head = append(row, $('.hivemindide-usage-card-head'));
		append(head, $('span.hivemindide-usage-card-label')).textContent = limit.label;
		if (limit.resetsAt !== undefined) {
			append(head, $('span.hivemindide-usage-card-reset')).textContent = formatResets(limit.resetsAt, now, language);
		}

		const bar = append(row, $(`.hivemindide-usage-card-bar.severity-${severityOf(percent)}`));
		append(bar, $('.hivemindide-usage-card-fill')).style.width = `${percent ?? 0}%`;

		append(row, $('.hivemindide-usage-card-used')).textContent = limit.exhausted
			? localize('usageNotch.card.exhausted', "Limit reached")
			: percent === undefined
				? localize('usageNotch.card.unknown', "Below the warning level (exact figure not reported)")
				: localize('usageNotch.card.used', "{0} used", formatPercent(percent));
	}

	private showContextMenu(e: MouseEvent): void {
		const keepOpen = this.keepOpen;
		const anchor = new StandardMouseEvent(getWindow(this.root), e);
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [
				toAction({ id: 'hivemindide.usageNotch.refresh', label: localize('usageNotch.menu.refresh', "Refresh"), run: () => this.model.refresh() }),
				toAction({
					id: 'hivemindide.usageNotch.keepOpen',
					label: localize('usageNotch.menu.keepOpen', "Keep Open"),
					checked: keepOpen,
					run: () => this.configurationService.updateValue(HivemindIDESettings.UsageNotchKeepOpen, !keepOpen, ConfigurationTarget.USER),
				}),
				toAction({
					id: 'hivemindide.usageNotch.resetPosition',
					label: localize('usageNotch.menu.resetPosition', "Reset Position"),
					run: () => this.resetPlacement(),
				}),
				toAction({
					id: 'hivemindide.usageNotch.hide',
					label: localize('usageNotch.menu.hide', "Hide Usage Notch"),
					run: () => this.configurationService.updateValue(HivemindIDESettings.UsageNotchEnabled, false, ConfigurationTarget.USER),
				}),
			],
		});
	}
}
