/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE MacBook notch: the usage notch moved into the hardware notch.
 *
 *  On a Mac whose built-in display has a camera notch, the main process keeps
 *  one small window over it, outside every editor window, so it is visible
 *  whatever app is in front. At rest it is the notch itself with two "ears":
 *  the Hivemind cell (the mascot) and the most urgent usage ring. Hovering
 *  drops it open to show every ring and what the agents are doing; an agent
 *  asking for permission drops it open by itself with the choices.
 *
 *  Each editor window reports the rings it computed; agent activity and
 *  permission requests come straight from the hivemind shell in the main
 *  process. Pure helpers for finding the notch live here so they can be tested.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const HIVEMIND_NOTCH_CHANNEL_NAME = 'hivemindideNotch';

export const IHivemindNotchService = createDecorator<IHivemindNotchService>('hivemindideNotchService');

/** One usage ring, already worded by the window that computed it. */
export interface INotchRing {
	readonly id: string;
	readonly label: string;
	readonly glyph: string;
	/** 0–100, or undefined when there is no figure yet. */
	readonly percent?: number;
	/** `ok`, `elevated`, `high`, `critical` or `unknown`: the ring's color. */
	readonly severity: string;
	/** "Current session · Resets in 48 min". */
	readonly detail: string;
	/** Every limit window still running, for the Usage tab's bars. */
	readonly windows: readonly INotchRingWindow[];
}

export interface INotchRingWindow {
	readonly label: string;
	readonly percent?: number;
	readonly severity: string;
	/** "Resets in 48 min". */
	readonly reset?: string;
	readonly exhausted?: boolean;
}

// ---- Agent activity -------------------------------------------------------------

/** One tool call of the agent's current run, as the checklist shows it. */
export interface INotchStep {
	readonly id: string;
	readonly title: string;
	readonly status: 'pending' | 'in_progress' | 'completed' | 'failed';
}

export interface INotchSteps {
	readonly sessionId?: string;
	readonly steps: readonly INotchStep[];
}

/** How many steps the checklist keeps: the latest ones. */
export const NOTCH_MAX_STEPS = 6;

/**
 * Folds one tool event into the checklist. A new session starts a new list;
 * a known call keeps its first title and takes the latest status (CLIs send
 * the title only when the call starts).
 */
export function applyNotchStep(current: INotchSteps, sessionId: string, event: { readonly toolCallId: string; readonly title?: string; readonly status?: INotchStep['status'] }): INotchSteps {
	const steps = current.sessionId === sessionId ? current.steps : [];
	const known = steps.find(s => s.id === event.toolCallId);
	const next: INotchStep = {
		id: event.toolCallId,
		title: clampText(known?.title ?? event.title ?? 'tool', 160),
		status: event.status ?? known?.status ?? 'in_progress',
	};
	const merged = known ? steps.map(s => s === known ? next : s) : [...steps, next];
	return { sessionId, steps: merged.slice(-NOTCH_MAX_STEPS) };
}

export type NotchPhase = 'asking' | 'working' | 'done' | 'idle';

/**
 * A turn is working from its first event until the shell reports its end; a
 * long tool call is silent, so silence is not the end. A turn with no event
 * for NOTCH_STUCK_MS (its end was lost) stops counting as working.
 */
export const NOTCH_STUCK_MS = 15 * 60_000;
/** How long a finished run shows as done before it goes idle. */
export const NOTCH_DONE_MS = 60_000;

/** `lastEventAt` is the latest event of an open turn, or the end of the last one. */
export function notchPhase(hasPermission: boolean, turnOpen: boolean, lastEventAt: number, now: number): NotchPhase {
	if (hasPermission) {
		return 'asking';
	}
	if (!lastEventAt) {
		return 'idle';
	}
	const since = now - lastEventAt;
	if (turnOpen) {
		return since < NOTCH_STUCK_MS ? 'working' : 'idle';
	}
	return since < NOTCH_DONE_MS ? 'done' : 'idle';
}

/** Keeps agent-supplied text to a size the notch can show and the IPC can carry. */
export function clampText(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export interface INotchWindowState {
	/** False when the window no longer wants the notch: the setting is off, or it is closing. */
	readonly enabled: boolean;
	readonly rings: readonly INotchRing[];
	/** `hivemindide.keepAwake.whileAgentsRun`: keep the Mac from sleeping while an agent works. */
	readonly keepAwakeWhileAgentsRun?: boolean;
}

/** Keep Awake, chosen in the notch: follow the setting, an hour, until turned off, or never. */
export type KeepAwakeMode = 'auto' | 'hour' | 'on' | 'off';

/** Why the Mac is being kept awake right now, if it is. */
export type KeepAwakeReason = 'agents' | 'hour' | 'on';

/** After the last turn ends, how long the Mac stays awake: a follow-up turn is often seconds away. */
export const KEEP_AWAKE_GRACE_MS = 2 * 60_000;
export const KEEP_AWAKE_HOUR_MS = 60 * 60_000;

export function keepAwakeReason(mode: KeepAwakeMode, setting: boolean, turnsOpen: boolean, lastTurnEndAt: number, hourUntil: number, now: number): KeepAwakeReason | undefined {
	switch (mode) {
		case 'off': return undefined;
		case 'on': return 'on';
		case 'hour': if (now < hourUntil) { return 'hour'; } break;
	}
	return setting && (turnsOpen || (lastTurnEndAt > 0 && now - lastTurnEndAt < KEEP_AWAKE_GRACE_MS)) ? 'agents' : undefined;
}

export interface IHivemindNotchService {
	readonly _serviceBrand: undefined;

	/** The hardware notch started or stopped showing. Windows hide their in-window notch while it shows. */
	readonly onDidChangeActive: Event<boolean>;
	isActive(): Promise<boolean>;
	/** What `windowId` wants shown. The notch shows while any window wants it and the Mac has one. */
	update(windowId: number, state: INotchWindowState): Promise<void>;
}

// ---- Finding the notch ------------------------------------------------------------

/** What AppKit says about one screen (NSScreen), in its bottom-left-origin points. */
export interface INotchScreenInfo {
	readonly frame: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
	/** `safeAreaInsets.top`: the notch's height, 0 without one. */
	readonly safeTop: number;
	/** `auxiliaryTopLeftArea` / `auxiliaryTopRightArea`: the menu bar either side of the notch. */
	readonly leftArea: { readonly x: number; readonly width: number };
	readonly rightArea: { readonly x: number; readonly width: number };
}

/** The subset of an Electron `Display` the match needs. */
export interface INotchDisplayInfo {
	readonly id: number;
	readonly internal: boolean;
	readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
}

export interface INotchRect {
	readonly displayId: number;
	/** In Electron screen coordinates (top-left origin), points. */
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

/**
 * The notch of the built-in display, in Electron screen coordinates, or
 * undefined when no screen has one (an external monitor only, an older Mac,
 * the lid closed).
 */
export function findNotch(screens: readonly INotchScreenInfo[], displays: readonly INotchDisplayInfo[]): INotchRect | undefined {
	for (const screen of screens) {
		if (screen.safeTop <= 0 || screen.leftArea.width <= 0 || screen.rightArea.width <= 0) {
			continue;
		}
		const display = displays.find(d => d.internal && Math.abs(d.bounds.width - screen.frame.width) < 1 && Math.abs(d.bounds.height - screen.frame.height) < 1)
			?? displays.find(d => Math.abs(d.bounds.width - screen.frame.width) < 1 && Math.abs(d.bounds.height - screen.frame.height) < 1);
		if (!display) {
			continue;
		}
		// The side areas may be given relative to the screen or in global
		// coordinates; whichever the left area is nearer to is the one in use.
		const origin = Math.abs(screen.leftArea.x - screen.frame.x) < Math.abs(screen.leftArea.x) ? screen.frame.x : 0;
		const left = screen.leftArea.x - origin + screen.leftArea.width;
		const right = screen.rightArea.x - origin;
		if (right - left < 20) {
			continue;
		}
		return { displayId: display.id, x: display.bounds.x + left, y: display.bounds.y, width: right - left, height: screen.safeTop };
	}
	return undefined;
}

/**
 * JavaScript for Automation that prints every screen's notch geometry as JSON.
 * AppKit is the only source for it, and `osascript` reaches AppKit without a
 * native module.
 */
export const NOTCH_PROBE_SCRIPT = `
ObjC.import('AppKit');
var screens = $.NSScreen.screens, out = [];
for (var i = 0; i < screens.count; i++) {
	var s = screens.objectAtIndex(i), f = s.frame, l = s.auxiliaryTopLeftArea, r = s.auxiliaryTopRightArea;
	out.push({ frame: { x: f.origin.x, y: f.origin.y, width: f.size.width, height: f.size.height }, safeTop: s.safeAreaInsets.top,
		leftArea: { x: l.origin.x, width: l.size.width }, rightArea: { x: r.origin.x, width: r.size.width } });
}
JSON.stringify(out);`;

/** The probe's output, or no screens when it is not what the probe prints. */
export function parseNotchProbe(output: string): INotchScreenInfo[] {
	try {
		const value = JSON.parse(output);
		return Array.isArray(value) ? value.filter(isScreenInfo) : [];
	} catch {
		return [];
	}
}

function isScreenInfo(value: unknown): value is INotchScreenInfo {
	const v = value as INotchScreenInfo;
	const n = (x: unknown) => typeof x === 'number' && isFinite(x);
	return !!v && !!v.frame && n(v.frame.x) && n(v.frame.width) && n(v.frame.height) && n(v.safeTop)
		&& !!v.leftArea && n(v.leftArea.x) && n(v.leftArea.width) && !!v.rightArea && n(v.rightArea.x) && n(v.rightArea.width);
}
