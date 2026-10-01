/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE hivemind shell: the agent runtime every hivemind node runs in.
 *
 *  The runtime (hivemind-agent) is a separate Node program driven over the
 *  Agent Client Protocol (ACP, JSON-RPC on stdio). The main process owns the
 *  one runtime process and multiplexes sessions over it; windows create a
 *  session per hivemind node, choose its route (provider + model), prompt it
 *  and receive its updates as events.
 *
 *  A session can instead run on an agent CLI the user already has installed
 *  (Claude Code, Cursor, Codex), driven in its headless mode: same session
 *  calls, same events, the CLI's own login and limits.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../base/common/event.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';

export const HIVEMIND_SHELL_CHANNEL_NAME = 'hivemindideShell';

export const IHivemindShellService = createDecorator<IHivemindShellService>('hivemindideShellService');

/** How to start the runtime. A different launch restarts it once it is idle. */
export interface IHivemindShellLaunch {
	/** Node 22.19+ to run it with. Empty finds one (PATH, nvm, Homebrew). */
	readonly nodePath?: string;
	/** Folder of a built hivemind-agent. Empty looks beside the editor, then in its resources. */
	readonly runtimePath?: string;
	/** Runtime home: profiles, persisted sessions. */
	readonly homePath: string;
	/** Profile overlay: provider routes and the default route. */
	readonly overlay: readonly object[];
	/** Secrets the overlay references by variable name. Never written to disk. */
	readonly secrets: Readonly<Record<string, string>>;
}

/** One choice of a select option (a route, a reasoning effort). `value` is opaque. */
export interface IHivemindShellChoice {
	readonly value: string;
	readonly name: string;
	readonly group?: string;
}

export interface IHivemindShellSession {
	readonly sessionId: string;
	readonly routes: readonly IHivemindShellChoice[];
	readonly route?: string;
	/** Empty when the current route has no reasoning-effort setting. */
	readonly efforts: readonly IHivemindShellChoice[];
	readonly effort?: string;
}

export type HivemindShellEvent =
	| { readonly sessionId: string; readonly kind: 'text' | 'thought'; readonly text: string }
	| { readonly sessionId: string; readonly kind: 'tool'; readonly toolCallId: string; readonly title?: string; readonly status?: 'pending' | 'in_progress' | 'completed' | 'failed' }
	| { readonly sessionId: string; readonly kind: 'usage'; readonly used: number; readonly size: number }
	/**
	 * A turn started, before the model says anything (a local model may load for
	 * seconds first). `provider`/`model` name the route; `local` when it runs on
	 * this machine (the Local route, or a provider at a loopback address).
	 */
	| { readonly sessionId: string; readonly kind: 'start'; readonly provider?: string; readonly model?: string; readonly local?: boolean; readonly endpoint?: string }
	/**
	 * The local model's server cut this turn's prompt to fit its context window:
	 * `sent` tokens went in, only the last `kept` were read. The answer is then
	 * about a fragment and should not be trusted. Fired before `end`.
	 */
	| { readonly sessionId: string; readonly kind: 'truncated'; readonly model?: string; readonly sent: number; readonly kept: number }
	/** The turn is over, however it ended. */
	| { readonly sessionId: string; readonly kind: 'end' }
	/**
	 * An agent CLI's plan usage limit, as the CLI reported it. `agent` is the CLI id
	 * (`claude`), `resetsAt` seconds since the epoch, `utilization` a fraction 0–1.
	 */
	| { readonly sessionId: string; readonly kind: 'limit'; readonly agent: string; readonly rejected: boolean; readonly limitType?: string; readonly resetsAt?: number; readonly utilization?: number };

export interface IHivemindShellPermissionRequest {
	readonly id: string;
	readonly sessionId: string;
	readonly title: string;
	readonly options: readonly { readonly optionId: string; readonly name: string; readonly kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' }[];
}

export type HivemindShellStopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

/** An agent CLI found on this machine. */
export interface IHivemindCliAgent {
	/** `claude`, `cursor-agent`, `codex`. */
	readonly id: string;
	/** Shown as the routes' provider: "Claude Code", "Cursor", "Codex". */
	readonly name: string;
	readonly path: string;
	readonly version: string;
	/** Models it can be asked for; `default` is whatever the CLI is configured to use. */
	readonly models: readonly string[];
}

/** What a CLI agent may do without asking, since headless CLIs cannot ask. */
export type HivemindCliPermissions = 'readOnly' | 'edits' | 'full';

/** Runs a session on an installed agent CLI instead of the runtime. */
export interface IHivemindCliBackend {
	readonly agent: string;
	readonly permissions: HivemindCliPermissions;
}

export interface IHivemindShellService {
	readonly _serviceBrand: undefined;

	readonly onDidEvent: Event<HivemindShellEvent>;
	/** Every window hears it; the one that owns the session answers with `respondPermission`. */
	readonly onDidRequestPermission: Event<IHivemindShellPermissionRequest>;
	/** A permission request was answered, from any window or the MacBook notch. Carries its id. */
	readonly onDidResolvePermission: Event<string>;
	/** The runtime exited. Sessions survive on disk and can be resumed. */
	readonly onDidExit: Event<string>;

	/** Starts the runtime, or restarts it when `launch` changed and nothing is running. */
	ensureStarted(launch: IHivemindShellLaunch): Promise<void>;
	/** Agent CLIs installed on this machine, looked up afresh. */
	detectCliAgents(): Promise<IHivemindCliAgent[]>;
	/** A session in the runtime, or on an agent CLI when `cli` is given (no runtime needed). */
	newSession(cwd: string, cli?: IHivemindCliBackend): Promise<IHivemindShellSession>;
	/** Reopens a persisted session, e.g. after the runtime restarted. */
	resumeSession(sessionId: string, cwd: string, cli?: IHivemindCliBackend): Promise<IHivemindShellSession>;
	/** `configId` is `model` (the route) or `reasoning_effort`. */
	setOption(sessionId: string, configId: string, value: string): Promise<IHivemindShellSession>;
	/** Runs one turn; updates arrive on `onDidEvent` until this settles. */
	prompt(sessionId: string, text: string): Promise<HivemindShellStopReason>;
	cancel(sessionId: string): Promise<void>;
	closeSession(sessionId: string): Promise<void>;
	/** `optionId` undefined declines. */
	respondPermission(id: string, optionId: string | undefined): Promise<void>;
	/**
	 * Reports a turn that runs outside the shell (a model without tools answers
	 * by a direct stream), so it shows like any other: `start`, then `end`.
	 */
	announce(event: HivemindShellEvent): Promise<void>;
	stop(): Promise<void>;
}
