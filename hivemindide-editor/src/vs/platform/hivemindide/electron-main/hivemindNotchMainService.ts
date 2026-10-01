/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE MacBook notch, main process side (see ../common/hivemindNotch.ts).
 *
 *  Owns the one notch window. It is a non-activating panel sitting over the
 *  camera notch at the screen-saver level (above the menu bar), on every Space
 *  and over full-screen apps, and click-through except where the black shape
 *  is: the page reports when the pointer is over it. Where no screen has a
 *  notch (a Mac without one, Windows, Linux) the same window draws one at the
 *  top center of the main display.
 *
 *  Holds nothing while no window wants it: no window, no cursor polling, no
 *  display listeners. Detection runs `osascript` once (macOS only), and again
 *  when a display is added, removed, resized, rescaled or rotated.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import { cpus, freemem, totalmem } from 'os';
import { BrowserWindow, Display, powerMonitor, powerSaveBlocker, screen } from 'electron';
import { RunOnceScheduler } from '../../../base/common/async.js';
import { CancellationToken } from '../../../base/common/cancellation.js';
import { Emitter } from '../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../base/common/lifecycle.js';
import { isMacintosh, isWindows } from '../../../base/common/platform.js';
import { localize } from '../../../nls.js';
import { ILogService } from '../../log/common/log.js';
import { FocusMode } from '../../native/common/native.js';
import { INativeRunActionInWindowRequest } from '../../window/common/window.js';
import { IWindowsMainService } from '../../windows/electron-main/windows.js';
import { applyNotchStep, clampText, findNotch, IHivemindNotchService, INotchRect, INotchRing, INotchStep, INotchSteps, INotchWindowState, KEEP_AWAKE_GRACE_MS, KEEP_AWAKE_HOUR_MS, KeepAwakeMode, KeepAwakeReason, keepAwakeReason, NOTCH_DONE_MS, NOTCH_PROBE_SCRIPT, NOTCH_STUCK_MS, NotchPhase, notchPhase, parseNotchProbe, virtualNotch } from '../common/hivemindNotch.js';
import { formatBytes, IGpuStats, IModelOffload, NVIDIA_SMI_ARGS, parseIoregGpu, parseNvidiaSmi, parseOllamaPs } from '../common/gpuStats.js';
import { cpuPercent, IListeningPort, isSystemListener, ISystemStats, parseLsofListening, parsePmsetBattery, parseVmStat } from '../common/systemStats.js';
import { HivemindShellEvent, IHivemindShellPermissionRequest, IHivemindShellService } from '../common/hivemindShell.js';
import { cliAgentSpec } from './cliAgents.js';
import { NOTCH_MESSAGE_PREFIX, notchPageUrl } from './notchPage.js';

/** Room around the notch for the open panel; the window is click-through outside the shape. */
const WINDOW_WIDTH = 640;
const WINDOW_HEIGHT = 420;
/** ~30 samples a second; the page glides the eyes between them every frame. Sent only when the cursor moved. */
const CURSOR_POLL_MS = 33;
/** GPU counters and Ollama's model placement, while a local model is shown. */
const GPU_POLL_MS = 1500;
/** CPU, memory, battery, heat and ports, while the Mac tab is open. */
const SYSTEM_POLL_MS = 2000;
/** Changes to a display that can move or resize its notch; work-area changes (menu bar, Dock) cannot. */
const NOTCH_METRICS = ['bounds', 'scaleFactor', 'rotation'];

interface IPageState {
	readonly notch: { readonly width: number; readonly height: number };
	readonly phase: NotchPhase;
	readonly agent?: string;
	/** "Ollama · on this Mac": where the shown session runs. */
	readonly route?: string;
	readonly steps: readonly INotchStep[];
	readonly rings: readonly INotchRing[];
	readonly permission?: { readonly id: string; readonly heading: string; readonly command: string; readonly options: readonly { readonly optionId: string; readonly name: string; readonly kind: string }[] };
	readonly keepAwake: { readonly mode: KeepAwakeMode; readonly reason?: KeepAwakeReason; readonly status: string };
	readonly system?: ISystemStats;
	readonly ports?: readonly (IListeningPort & { readonly own: boolean })[];
	readonly labels: Record<string, string>;
}

type PageMessage =
	| { readonly type: 'ready' }
	| { readonly type: 'hover'; readonly inside: boolean }
	| { readonly type: 'focus' }
	| { readonly type: 'settings' }
	| { readonly type: 'tab'; readonly tab: string }
	| { readonly type: 'keepAwake'; readonly mode: KeepAwakeMode }
	| { readonly type: 'stopPort'; readonly pid: number; readonly port: number }
	| { readonly type: 'permission'; readonly id: string; readonly optionId: string };

const KEEP_AWAKE_MODES: readonly KeepAwakeMode[] = ['auto', 'hour', 'on', 'off'];

export class HivemindNotchMainService extends Disposable implements IHivemindNotchService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeActive = this._register(new Emitter<boolean>());
	readonly onDidChangeActive = this._onDidChangeActive.event;

	private readonly windows = new Map<number, INotchWindowState>();
	private rings: readonly INotchRing[] = [];
	private notch: INotchRect | undefined;
	private detected = false;
	private detecting: Promise<void> | undefined;

	/** Everything that exists only while the notch shows. */
	private readonly session = this._register(new MutableDisposable<DisposableStore>());
	private window: BrowserWindow | undefined;
	private pageReady = false;

	private agent: string | undefined;
	private steps: INotchSteps = { steps: [] };
	private lastEventAt = 0;
	/** Sessions with a turn running: between their first event and the shell's `end`. */
	private readonly openTurns = new Set<string>();
	/** Each session's route, from its `start` event, and its context window, from `usage`. */
	private readonly routes = new Map<string, { readonly provider?: string; readonly model?: string; readonly local?: boolean; readonly endpoint?: string }>();
	/** The GPU and, for Ollama, how much of the model it holds: read while a local model is shown. */
	private gpu: IGpuStats | undefined;
	private offload: IModelOffload | undefined;
	private gpuKey = '';
	private gpuReading = false;
	private readonly context = new Map<string, { readonly used: number; readonly size: number }>();
	/** Sessions whose last turn's prompt the local model's server cut to fit. */
	private readonly truncated = new Map<string, { readonly sent: number; readonly kept: number }>();
	private current: string | undefined;
	/** Re-pushes when a run goes quiet (working → done) and when done turns to idle. */
	private readonly phaseTimer = this._register(new RunOnceScheduler(() => this.onPhaseTimer(), NOTCH_DONE_MS));
	private readonly permissions: IHivemindShellPermissionRequest[] = [];
	private lastPushedPhase: NotchPhase | undefined;
	private lastCursor = '';

	/** Keep Awake: the setting (from the windows), the notch's own mode, and the blocker while it holds. */
	private keepAwakeSetting = true;
	private keepAwakeMode: KeepAwakeMode = 'auto';
	private keepAwakeHourUntil = 0;
	private lastTurnEndAt = 0;
	private blocker: number | undefined;
	private readonly keepAwakeTimer = this._register(new RunOnceScheduler(() => this.reconcileKeepAwake(), KEEP_AWAKE_GRACE_MS));

	/** The Mac tab: read only while it is open. */
	private macTab = false;
	private system: ISystemStats | undefined;
	private ports: (IListeningPort & { own: boolean })[] | undefined;
	private systemKey = '';
	private systemReading = false;
	private cpuBefore = cpus();

	constructor(
		@IHivemindShellService private readonly shellService: IHivemindShellService,
		@IWindowsMainService private readonly windowsMainService: IWindowsMainService,
		@ILogService private readonly logService: ILogService,
	) {
		super();

		// Agent activity arrives whether or not the notch shows, so it is current when it opens.
		this._register(this.shellService.onDidEvent(e => this.onShellEvent(e)));
		this._register(this.shellService.onDidRequestPermission(request => {
			this.permissions.push(request);
			this.push();
		}));
		this._register(this.shellService.onDidResolvePermission(id => {
			const index = this.permissions.findIndex(p => p.id === id);
			if (index >= 0) {
				this.permissions.splice(index, 1);
				this.push();
			}
		}));
		this._register(this.windowsMainService.onDidDestroyWindow(window => {
			if (this.windows.delete(window.id)) {
				this.reconcile();
			}
		}));
		this._register(toDisposable(() => this.releaseBlocker()));
	}

	async isActive(): Promise<boolean> {
		return !!this.window;
	}

	async update(windowId: number, state: INotchWindowState): Promise<void> {
		this.windows.set(windowId, state);
		if (state.enabled) {
			this.rings = state.rings;
		}
		// Any window that wants it keeps the Mac awake while agents work; a window that turned the notch off entirely says false.
		this.keepAwakeSetting = [...this.windows.values()].some(s => s.keepAwakeWhileAgentsRun !== false);
		this.reconcileKeepAwake();
		if (this.wanted() && !this.detected) {
			await this.detect();
		}
		this.reconcile();
	}

	private wanted(): boolean {
		return [...this.windows.values()].some(s => s.enabled);
	}

	// ---- Detection --------------------------------------------------------------------

	/** The camera notch if a screen has one, else one drawn at the top center of the main display. */
	private detect(): Promise<void> {
		this.detecting ??= (async () => {
			const real = isMacintosh ? await this.findHardwareNotch() : undefined;
			this.notch = real ?? virtualNotch(screen.getPrimaryDisplay(), isMacintosh);
			this.logService.info(`[hivemind notch] ${this.notch.virtual ? 'drawn' : 'camera'} notch ${this.notch.width}x${this.notch.height} at ${this.notch.x},${this.notch.y}`);
			this.detected = true;
			this.detecting = undefined;
		})();
		return this.detecting;
	}

	private findHardwareNotch(): Promise<INotchRect | undefined> {
		return new Promise(resolve => {
			execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', NOTCH_PROBE_SCRIPT], { timeout: 5000 }, (err, stdout) => {
				if (err) {
					this.logService.warn('[hivemind notch] could not read the screen geometry', err.message);
					resolve(undefined);
					return;
				}
				const displays = screen.getAllDisplays().map((d: Display) => ({ id: d.id, internal: d.internal, bounds: d.bounds }));
				resolve(findNotch(parseNotchProbe(String(stdout).trim()), displays));
			});
		});
	}

	// ---- The window -------------------------------------------------------------------

	/** Shows or removes the notch to match what the windows want and what the Mac has. */
	private reconcile(): void {
		const show = this.wanted() && !!this.notch;
		if (show && !this.window) {
			this.open();
		} else if (!show && this.window) {
			this.session.clear();
		} else {
			this.position();
			this.push();
		}
	}

	private open(): void {
		const store = new DisposableStore();
		const window = new BrowserWindow({
			// macOS: a non-activating panel. Windows: never take focus from the app in front, though clicks still land.
			type: isMacintosh ? 'panel' : undefined,
			focusable: !isWindows,
			show: false,
			frame: false,
			transparent: true,
			backgroundColor: '#00000000',
			hasShadow: false,
			resizable: false,
			movable: false,
			minimizable: false,
			maximizable: false,
			fullscreenable: false,
			skipTaskbar: true,
			// Allowed above the menu bar, where the notch is.
			enableLargerThanScreen: true,
			acceptFirstMouse: true,
			roundedCorners: false,
			webPreferences: {
				sandbox: true,
				contextIsolation: true,
				nodeIntegration: false,
				devTools: false,
				backgroundThrottling: false,
				spellcheck: false,
				// Its own in-memory session, apart from the workbench's.
				partition: 'hivemind-notch',
			},
		});
		this.window = window;
		this.pageReady = false;
		store.add(toDisposable(() => {
			this.window = undefined;
			if (!window.isDestroyed()) {
				window.destroy();
			}
			this._onDidChangeActive.fire(false);
		}));

		window.setAlwaysOnTop(true, 'screen-saver');
		window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
		window.setIgnoreMouseEvents(true, { forward: true });

		window.webContents.on('console-message', details => this.onPageMessage(details.message));
		window.on('closed', () => this.session.clear());

		const redetect = new RunOnceScheduler(async () => {
			this.detected = false;
			await this.detect();
			this.reconcile();
		}, 500);
		store.add(redetect);
		const onDisplays = () => redetect.schedule();
		const onMetrics = (_event: unknown, _display: Display, changed: string[]) => {
			if (changed.some(metric => NOTCH_METRICS.includes(metric))) {
				redetect.schedule();
			}
		};
		screen.on('display-added', onDisplays);
		screen.on('display-removed', onDisplays);
		screen.on('display-metrics-changed', onMetrics);
		store.add(toDisposable(() => {
			screen.off('display-added', onDisplays);
			screen.off('display-removed', onDisplays);
			screen.off('display-metrics-changed', onMetrics);
		}));

		// Only while it shows: the mascot's eyes follow the pointer.
		const cursor = setInterval(() => this.pushCursor(), CURSOR_POLL_MS);
		store.add(toDisposable(() => clearInterval(cursor)));
		// Only while it shows, and only reads anything while a local model is the one shown.
		const gpu = setInterval(() => this.refreshGpu(), GPU_POLL_MS);
		store.add(toDisposable(() => clearInterval(gpu)));
		// Only while it shows, and only reads anything while the Mac tab is open.
		const system = setInterval(() => this.refreshSystem(), SYSTEM_POLL_MS);
		store.add(toDisposable(() => { clearInterval(system); this.macTab = false; }));

		this.session.value = store;
		this.position();
		window.loadURL(notchPageUrl());
		window.once('ready-to-show', () => window.showInactive());
		this._onDidChangeActive.fire(true);
	}

	private position(): void {
		if (!this.window || !this.notch) {
			return;
		}
		const x = Math.round(this.notch.x + this.notch.width / 2 - WINDOW_WIDTH / 2);
		this.window.setBounds({ x, y: this.notch.y, width: WINDOW_WIDTH, height: WINDOW_HEIGHT });
	}

	// ---- Agent activity ------------------------------------------------------------------

	private onShellEvent(e: HivemindShellEvent): void {
		if (e.kind === 'end') {
			if (this.openTurns.delete(e.sessionId)) {
				this.lastEventAt = Date.now();
				this.lastTurnEndAt = this.lastEventAt;
				this.phaseTimer.schedule(NOTCH_DONE_MS);
				this.reconcileKeepAwake();
				this.push();
			}
			return;
		}
		if (e.kind === 'truncated') {
			this.truncated.set(e.sessionId, { sent: e.sent, kept: e.kept });
			this.push();
			return;
		}
		if (e.kind === 'start') {
			this.truncated.delete(e.sessionId);
			this.routes.set(e.sessionId, { provider: e.provider, model: e.model, local: e.local, endpoint: e.endpoint });
			this.openTurns.add(e.sessionId);
			this.reconcileKeepAwake();
			this.show(e.sessionId);
			this.lastEventAt = Date.now();
			this.phaseTimer.schedule(NOTCH_STUCK_MS);
			this.push();
			return;
		}
		if (e.kind === 'usage') {
			// The context window: for a local model, the one limit there is.
			const before = contextPercent(this.context.get(e.sessionId));
			this.context.set(e.sessionId, { used: e.used, size: e.size });
			if (e.sessionId === this.current && Math.round(before ?? -1) !== Math.round(contextPercent(this.context.get(e.sessionId)) ?? -1)) {
				this.push();
			}
			return;
		}
		if (e.kind !== 'tool' && e.kind !== 'text' && e.kind !== 'thought') {
			return;
		}
		const wasWorking = this.phase() === 'working';
		if (!this.openTurns.has(e.sessionId)) {
			this.openTurns.add(e.sessionId);
			this.reconcileKeepAwake();
		}
		this.show(e.sessionId);
		this.lastEventAt = Date.now();
		if (e.kind === 'tool') {
			this.steps = applyNotchStep(this.steps, e.sessionId, { toolCallId: e.toolCallId, title: e.title, status: e.status });
		} else if (this.steps.sessionId !== e.sessionId) {
			this.steps = { sessionId: e.sessionId, steps: [] };
		}
		// Only fires if the end never comes.
		this.phaseTimer.schedule(NOTCH_STUCK_MS);
		// Replies stream in many chunks; only a step or the start of a run changes what shows.
		if (e.kind === 'tool' || !wasWorking) {
			this.push();
		}
	}

	// ---- Keep Awake ------------------------------------------------------------------

	/**
	 * Holds a power-save blocker exactly while there is a reason to: an agent at
	 * work (and a couple of minutes after), an hour asked for, or "on". Only
	 * system sleep is held off; the display still sleeps, as with `caffeinate -i`.
	 */
	private reconcileKeepAwake(): void {
		const now = Date.now();
		const reason = keepAwakeReason(this.keepAwakeMode, this.keepAwakeSetting, this.openTurns.size > 0, this.lastTurnEndAt, this.keepAwakeHourUntil, now);
		if (reason && this.blocker === undefined) {
			this.blocker = powerSaveBlocker.start('prevent-app-suspension');
			this.logService.info(`[hivemind notch] keeping the Mac awake (${reason})`);
		} else if (!reason) {
			this.releaseBlocker();
		}
		// Wake up again when the reason can lapse: the hour ends, or the grace after the last turn does.
		const next = [
			this.keepAwakeMode === 'hour' ? this.keepAwakeHourUntil - now : undefined,
			reason === 'agents' && this.openTurns.size === 0 ? this.lastTurnEndAt + KEEP_AWAKE_GRACE_MS - now : undefined,
		].filter((ms): ms is number => ms !== undefined && ms > 0);
		if (next.length) {
			this.keepAwakeTimer.schedule(Math.min(...next) + 50);
		} else {
			this.keepAwakeTimer.cancel();
		}
		if (this.keepAwakeMode === 'hour' && now >= this.keepAwakeHourUntil) {
			this.keepAwakeMode = 'auto';
		}
		this.push();
	}

	private releaseBlocker(): void {
		if (this.blocker !== undefined) {
			powerSaveBlocker.stop(this.blocker);
			this.blocker = undefined;
			this.logService.info('[hivemind notch] letting the Mac sleep again');
		}
	}

	private keepAwakeState(): IPageState['keepAwake'] {
		const now = Date.now();
		const reason = keepAwakeReason(this.keepAwakeMode, this.keepAwakeSetting, this.openTurns.size > 0, this.lastTurnEndAt, this.keepAwakeHourUntil, now);
		const status = reason === 'on' ? localize('notch.awake.on', "Awake until you turn it off")
			: reason === 'hour' ? localize('notch.awake.hour', "Awake for {0} more min", Math.max(1, Math.ceil((this.keepAwakeHourUntil - now) / 60_000)))
				: reason === 'agents' ? (this.openTurns.size ? localize('notch.awake.agents', "Awake while agents work") : localize('notch.awake.grace', "Awake a moment after the last run"))
					: this.keepAwakeMode === 'off' ? (isMacintosh ? localize('notch.awake.off', "Off: the Mac may sleep") : localize('notch.awake.offPc', "Off: the computer may sleep"))
						: this.keepAwakeSetting ? localize('notch.awake.ready', "Stays awake when an agent runs") : localize('notch.awake.none', "Off");
		return { mode: this.keepAwakeMode, reason, status };
	}

	// ---- The Mac tab: CPU, memory, battery, heat and ports ---------------------------------------

	private async refreshSystem(): Promise<void> {
		if (!this.macTab || this.systemReading) {
			return;
		}
		this.systemReading = true;
		try {
			const now = cpus();
			const cpu = cpuPercent(this.cpuBefore, now);
			this.cpuBefore = now;
			// vm_stat and pmset are macOS tools; Linux has lsof too; Windows lists no ports here.
			const [vm, batt, lsof] = await Promise.all([
				isMacintosh ? run('/usr/bin/vm_stat', []) : undefined,
				isMacintosh ? run('/usr/bin/pmset', ['-g', 'batt']) : undefined,
				isWindows ? undefined : run(isMacintosh ? '/usr/sbin/lsof' : 'lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']),
			]);
			this.system = {
				cpu,
				memoryUsed: vm ? parseVmStat(vm) : isMacintosh ? undefined : totalmem() - freemem(),
				memoryTotal: totalmem(),
				battery: batt ? parsePmsetBattery(batt) : undefined,
				thermal: powerMonitor.getCurrentThermalState(),
			};
			// HivemindIDE's own processes (the editor, its helpers) are listed but cannot be stopped from here.
			this.ports = lsof === undefined ? undefined : parseLsofListening(lsof)
				.filter(p => !isSystemListener(p.command))
				.map(p => ({ ...p, command: clampText(p.command, 40), own: p.pid === process.pid || /^HivemindIDE/.test(p.command) }));
			const key = JSON.stringify([Math.round(cpu ?? -1), this.system.memoryUsed && Math.round(this.system.memoryUsed / 1e8), this.system.battery, this.system.thermal, this.ports]);
			if (key !== this.systemKey) {
				this.systemKey = key;
				this.push();
			}
		} finally {
			this.systemReading = false;
		}
	}

	private stopPort(pid: number, port: number): void {
		const listed = this.ports?.find(p => p.pid === pid && p.port === port);
		// Only a process the notch just listed as listening, and never HivemindIDE itself.
		if (!listed || listed.own || !Number.isInteger(pid) || pid <= 1) {
			return;
		}
		try {
			process.kill(pid, 'SIGTERM');
			this.logService.info(`[hivemind notch] stopped ${listed.command} (pid ${pid}) listening on :${port}`);
		} catch (err) {
			this.logService.warn(`[hivemind notch] could not stop pid ${pid}`, err instanceof Error ? err.message : String(err));
		}
		setTimeout(() => { this.systemKey = ''; this.refreshSystem(); }, 600);
	}

	/** The session the agent card follows: the one that last started or spoke. */
	private show(sessionId: string): void {
		this.current = sessionId;
		this.agent = this.displayName(sessionId);
	}

	/**
	 * An agent CLI by its own name ("Cursor": its model is often just "auto");
	 * a provider route by its model ("qwen2.5:1.5b").
	 */
	private displayName(sessionId: string): string {
		return sessionId.startsWith('cli:') ? agentName(sessionId) : this.routes.get(sessionId)?.model ?? agentName(sessionId);
	}

	/** "Ollama · local", "Claude Code": where the shown session runs. */
	private routeLine(): string | undefined {
		const route = this.current ? this.routes.get(this.current) : undefined;
		if (!route?.provider) {
			return undefined;
		}
		return route.local ? localize('notch.routeLocal', "{0} · local", route.provider) : route.model ? route.provider : undefined;
	}

	/** While the shown session runs on this Mac: a tile for its model, filled by its context window. */
	private localRing(): INotchRing | undefined {
		const route = this.current ? this.routes.get(this.current) : undefined;
		if (!route?.local || !route.model) {
			return undefined;
		}
		const ctx = this.current ? this.context.get(this.current) : undefined;
		const percent = contextPercent(ctx);
		const severity = severityOfPercent(percent);
		const tokens = ctx ? localize('notch.contextTokens', "{0} of {1} tokens", formatTokens(ctx.used), formatTokens(ctx.size)) : undefined;
		const offload = this.offload;
		// A direct answer (a model without tools) reports no context: leave the row out rather than show "—".
		const windows: { label: string; percent?: number; severity: string; reset?: string }[] = ctx ? [{ label: localize('notch.contextWindow', "Context window"), percent, severity, reset: tokens }] : [];
		if (offload) {
			windows.push({
				label: localize('notch.inGpu', "Model in GPU memory"), percent: offload.gpuPercent, severity: 'ok',
				reset: localize('notch.modelSize', "{0} model", formatBytes(offload.bytes)),
			});
		}
		const cut = this.current ? this.truncated.get(this.current) : undefined;
		if (cut) {
			// The model only saw the end of the prompt: say so where the context ring is.
			windows.unshift({
				label: localize('notch.promptCut', "Prompt cut off"), percent: 100, severity: 'critical',
				reset: localize('notch.promptCutTokens', "{0} of {1} tokens kept", formatTokens(cut.kept), formatTokens(cut.sent)),
			});
		}
		return {
			id: 'local',
			label: route.model,
			glyph: 'LM',
			percent: cut ? 100 : percent,
			severity: cut ? 'critical' : severity,
			detail: cut
				? localize('notch.promptCutShort', "Prompt cut off")
				: offload
					? (isMacintosh ? localize('notch.onThisMacGpu', "On this Mac · {0}% GPU", Math.round(offload.gpuPercent)) : localize('notch.onThisPcGpu', "On this computer · {0}% GPU", Math.round(offload.gpuPercent)))
					: (isMacintosh ? localize('notch.onThisMac', "On this Mac") : localize('notch.onThisPc', "On this computer")),
			windows,
		};
	}

	/** While a local model is shown: the GPU it runs on, filled by how busy it is. */
	private gpuRing(): INotchRing | undefined {
		const route = this.current ? this.routes.get(this.current) : undefined;
		const gpu = this.gpu;
		if (!route?.local || !gpu) {
			return undefined;
		}
		const memory = gpu.memoryUsed !== undefined && gpu.memoryTotal ? gpu.memoryUsed / gpu.memoryTotal * 100 : undefined;
		const memoryText = gpu.memoryUsed === undefined ? undefined : gpu.memoryTotal
			? localize('notch.gpuMemory', "{0} of {1}", formatBytes(gpu.memoryUsed), formatBytes(gpu.memoryTotal))
			: formatBytes(gpu.memoryUsed);
		const parts = [gpu.backend, gpu.memoryUsed !== undefined ? formatBytes(gpu.memoryUsed) : undefined, gpu.temperatureC !== undefined ? `${gpu.temperatureC}°C` : undefined].filter(Boolean);
		return {
			id: 'gpu',
			label: gpu.cores ? localize('notch.gpuCores', "{0} · {1}-core GPU", gpu.name, gpu.cores) : gpu.name,
			glyph: 'GPU',
			percent: gpu.utilization,
			// A busy GPU is the point of a local model; only memory running out is a warning.
			severity: memory !== undefined && memory >= 90 ? 'high' : 'ok',
			detail: parts.join(' · '),
			windows: [
				{ label: localize('notch.gpuBusy', "GPU busy"), percent: gpu.utilization, severity: 'ok', reset: gpu.backend },
				...(memoryText ? [{ label: localize('notch.gpuMemoryLabel', "GPU memory"), percent: memory, severity: severityOfPercent(memory), reset: memoryText }] : []),
			],
		};
	}

	private async refreshGpu(): Promise<void> {
		const route = this.current ? this.routes.get(this.current) : undefined;
		if (!route?.local || this.gpuReading) {
			return;
		}
		this.gpuReading = true;
		try {
			const [gpu, offload] = await Promise.all([readGpu(), readOffload(route.endpoint, route.model)]);
			const key = JSON.stringify([gpu, offload]);
			if (key !== this.gpuKey) {
				this.gpuKey = key;
				this.gpu = gpu;
				this.offload = offload;
				this.push();
			}
		} finally {
			this.gpuReading = false;
		}
	}

	private phase(): NotchPhase {
		return notchPhase(this.permissions.length > 0, this.openTurns.size > 0, this.lastEventAt, Date.now());
	}

	/** Done has run its minute, or a turn never ended: show the phase it is now. */
	private onPhaseTimer(): void {
		this.push();
	}

	// ---- State for the page ------------------------------------------------------------

	private push(): void {
		const window = this.window;
		if (!window || !this.pageReady || !this.notch || window.isDestroyed()) {
			return;
		}
		const phase = this.phase();
		this.lastPushedPhase = phase;
		const permission = this.permissions[0];
		const local = [this.localRing(), this.gpuRing()].filter((r): r is INotchRing => !!r);
		const state: IPageState = {
			notch: { width: this.notch.width, height: this.notch.height },
			phase,
			agent: this.agent,
			route: this.routeLine(),
			steps: this.steps.steps,
			rings: [...local, ...this.rings],
			permission: permission && {
				id: permission.id,
				heading: localize('notch.ask', "{0} wants to run", this.displayName(permission.sessionId)),
				command: clampText(permission.title, 600),
				options: [...permission.options].sort((a, b) => PERMISSION_ORDER.indexOf(a.kind) - PERMISSION_ORDER.indexOf(b.kind)).slice(0, 3).map(o => ({ ...o, name: clampText(o.name, 24) })),
			},
			keepAwake: this.keepAwakeState(),
			system: this.macTab ? this.system : undefined,
			ports: this.macTab ? this.ports : undefined,
			labels: {
				hivemind: localize('notch.hivemind', "Hivemind"),
				home: localize('notch.home', "Home"),
				usage: localize('notch.usage', "Usage"),
				settings: localize('notch.settings', "HivemindIDE Settings"),
				open: localize('notch.open', "Open HivemindIDE"),
				working: localize('notch.working', "Working"),
				asking: localize('notch.asking', "Needs you"),
				done: localize('notch.done', "Done"),
				idle: localize('notch.idle', "Idle"),
				noRun: localize('notch.noRun', "No agent has run yet. Start one from the chat."),
				noUsage: localize('notch.noUsage', "No usage readings yet."),
				limitReached: localize('notch.limitReached', "{0} limit reached"),
				mac: isMacintosh ? localize('notch.macTab', "Mac") : localize('notch.systemTab', "System"),
				keepAwake: localize('notch.keepAwake', "Keep awake"),
				modeAuto: localize('notch.mode.auto', "Agents"),
				modeHour: localize('notch.mode.hour', "1 hour"),
				modeOn: localize('notch.mode.on', "On"),
				modeOff: localize('notch.mode.off', "Off"),
				cpu: localize('notch.cpu', "CPU"),
				memory: localize('notch.memory', "Memory"),
				battery: localize('notch.battery', "Battery"),
				charging: localize('notch.charging', "Charging"),
				onPower: localize('notch.onPower', "On power"),
				left: localize('notch.left', "{0} left"),
				heat: localize('notch.heat', "Heat"),
				thermal_nominal: localize('notch.thermal.nominal', "Cool"),
				thermal_fair: localize('notch.thermal.fair', "Warm"),
				thermal_serious: localize('notch.thermal.serious', "Hot, slowing down"),
				thermal_critical: localize('notch.thermal.critical', "Too hot"),
				thermal_unknown: localize('notch.thermal.unknown', "Unknown"),
				ports: localize('notch.ports', "Listening ports"),
				noPorts: localize('notch.noPorts', "Nothing is listening."),
				noPortsHere: localize('notch.noPortsHere', "Listening ports are not listed on this system."),
				stop: localize('notch.stop', "Stop"),
				confirmStop: localize('notch.confirmStop', "Stop?"),
				ownProcess: localize('notch.ownProcess', "HivemindIDE"),
				used: localize('notch.used', "{0} used"),
				more: localize('notch.more', "+{0} more"),
			},
		};
		window.webContents.executeJavaScript(`window.__notch && window.__notch(${JSON.stringify(state)})`, true).catch(() => { /* page reloading */ });
	}

	private pushCursor(): void {
		const window = this.window;
		if (!window || !this.pageReady || window.isDestroyed()) {
			return;
		}
		// A run can go quiet between cursor moves; keep the chip honest.
		if (this.lastPushedPhase !== this.phase()) {
			this.push();
		}
		const point = screen.getCursorScreenPoint();
		const bounds = window.getBounds();
		const key = `${point.x - bounds.x},${point.y - bounds.y}`;
		if (key !== this.lastCursor) {
			this.lastCursor = key;
			window.webContents.executeJavaScript(`window.__notchCursor && window.__notchCursor(${key})`, true).catch(() => { /* page reloading */ });
		}
	}

	// ---- Messages from the page ---------------------------------------------------------

	private onPageMessage(raw: string): void {
		if (!raw.startsWith(NOTCH_MESSAGE_PREFIX) || raw.length > 4096) {
			return;
		}
		let message: PageMessage;
		try {
			message = JSON.parse(raw.slice(NOTCH_MESSAGE_PREFIX.length));
		} catch {
			return;
		}
		switch (message?.type) {
			case 'ready':
				this.pageReady = true;
				this.push();
				break;
			case 'hover':
				// Take clicks only while the pointer is over the black shape.
				this.window?.setIgnoreMouseEvents(message.inside !== true, { forward: true });
				break;
			case 'focus':
				this.windowsMainService.getLastActiveWindow()?.focus({ mode: FocusMode.Force });
				break;
			case 'tab':
				this.macTab = message.tab === 'mac';
				if (this.macTab) {
					this.systemKey = '';
					this.refreshSystem();
				}
				break;
			case 'keepAwake':
				if (KEEP_AWAKE_MODES.includes(message.mode)) {
					this.keepAwakeMode = message.mode;
					this.keepAwakeHourUntil = message.mode === 'hour' ? Date.now() + KEEP_AWAKE_HOUR_MS : 0;
					this.reconcileKeepAwake();
				}
				break;
			case 'stopPort':
				if (typeof message.pid === 'number' && typeof message.port === 'number') {
					this.stopPort(message.pid, message.port);
				}
				break;
			case 'settings': {
				const target = this.windowsMainService.getLastActiveWindow();
				target?.focus({ mode: FocusMode.Force });
				const request: INativeRunActionInWindowRequest = { id: 'hivemindide.action.openSettings', from: 'mouse' };
				target?.sendWhenReady('vscode:runAction', CancellationToken.None, request);
				break;
			}
			case 'permission': {
				const request = this.permissions.find(p => p.id === message.id);
				// Only an option the agent offered for a request still open.
				if (request && typeof message.optionId === 'string' && request.options.some(o => o.optionId === message.optionId)) {
					this.shellService.respondPermission(request.id, message.optionId);
				}
				break;
			}
		}
	}
}

function severityOfPercent(percent: number | undefined): string {
	return percent === undefined ? 'unknown' : percent >= 90 ? 'critical' : percent >= 70 ? 'high' : percent >= 50 ? 'elevated' : 'ok';
}

function run(command: string, args: readonly string[]): Promise<string | undefined> {
	return new Promise(resolve => execFile(command, args, { timeout: 2000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? undefined : String(stdout))));
}

/** Apple silicon from the driver's counters; elsewhere NVIDIA's own tool. Undefined when neither answers. */
async function readGpu(): Promise<IGpuStats | undefined> {
	if (isMacintosh) {
		const out = await run('/usr/sbin/ioreg', ['-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator']);
		return out ? parseIoregGpu(out, totalmem()) : undefined;
	}
	const out = await run('nvidia-smi', NVIDIA_SMI_ARGS);
	return out ? parseNvidiaSmi(out) : undefined;
}

/** For an Ollama endpoint on this machine: how much of `model` is in GPU memory. Anything else has no such API. */
async function readOffload(endpoint: string | undefined, model: string | undefined): Promise<IModelOffload | undefined> {
	if (!endpoint || !model) {
		return undefined;
	}
	try {
		const response = await fetch(`${new URL(endpoint).origin}/api/ps`, { signal: AbortSignal.timeout(1500) });
		return response.ok ? parseOllamaPs(await response.text()).find(m => m.model === model || m.model === `${model}:latest`) : undefined;
	} catch {
		return undefined;
	}
}

function contextPercent(ctx: { readonly used: number; readonly size: number } | undefined): number | undefined {
	return ctx && ctx.size > 0 ? Math.min(100, Math.max(0, ctx.used / ctx.size * 100)) : undefined;
}

/** 1234 -> "1.2k", 131072 -> "131k". */
function formatTokens(n: number): string {
	return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

const PERMISSION_ORDER =['reject_once', 'reject_always', 'allow_always', 'allow_once'];

/** `cli:claude:<uuid>` -> "Claude Code"; runtime sessions run on Hivemind. */
function agentName(sessionId: string): string {
	const [prefix, agent] = sessionId.split(':');
	return prefix === 'cli' && agent ? cliAgentSpec(agent)?.name ?? agent : localize('notch.agent', "Hivemind agent");
}
