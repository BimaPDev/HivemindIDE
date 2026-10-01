/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE team: who shares this repo's coordination hub, and your place in it.
 *
 *  The hub is the one in hivemindide.agentTree.coordinationUrl, the repo the one
 *  in hivemindide.agentTree.repoId. Once a repo has a team, everything about it
 *  (presence, leases, the live stream) needs a member's token; this service
 *  keeps yours in secret storage and hands it to everything that talks to the
 *  hub. Only owners and admins share: the hub enforces that, and the UI only
 *  offers what your role allows.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import { CoordinationClient, CoordinationError, TeamRole, TeamSignIn, TeamView } from '../../../../services/hivemindide/common/coordinationClient.js';
import { HivemindIDESettings } from '../../common/hivemindideConfiguration.js';

export const ITeamService = createDecorator<ITeamService>('hivemindideTeamService');

export type TeamState =
	/** No hub or repo configured. */
	| { readonly kind: 'unconfigured' }
	| { readonly kind: 'loading' }
	/** Not signed in. `hasTeam`: the repo has a team (join it) or not (create one). */
	| { readonly kind: 'signedOut'; readonly hasTeam: boolean | undefined }
	| { readonly kind: 'signedIn'; readonly view: TeamView }
	| { readonly kind: 'error'; readonly message: string };

export interface ITeamService {
	readonly _serviceBrand: undefined;

	readonly onDidChange: Event<void>;
	readonly state: TeamState;
	/** The hub and repo this is about, when configured. */
	readonly hub: { readonly url: string; readonly repoId: string } | undefined;

	refresh(): Promise<void>;
	/** A client for this repo's hub carrying your token, for anything that talks to it. */
	client(): Promise<CoordinationClient | undefined>;

	createTeam(displayName: string, setupSecret?: string): Promise<void>;
	joinTeam(code: string, displayName: string): Promise<void>;
	/** Owner or admin: returns the one-time code to pass on. */
	invite(role: TeamRole, ttlHours: number, maxUses: number): Promise<string>;
	revokeInvite(inviteId: string): Promise<void>;
	setRole(userId: string, role: TeamRole): Promise<void>;
	removeMember(userId: string): Promise<void>;
	transferOwnership(userId: string): Promise<void>;
	leave(): Promise<void>;
	/** Forgets your token on this machine. You stay a member. */
	signOut(): Promise<void>;
}

const TOKEN_KEY_PREFIX = 'hivemindide.team.token:';

/** The close code coordinationd ends a stream with when its viewer may no longer see the repo. */
export const STREAM_CLOSED_LOST_ACCESS = 4001;

/** A stable id from a display name: "Alice Ng" → "alice-ng". */
export function userIdFor(displayName: string): string {
	return displayName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'user';
}

export class TeamService extends Disposable implements ITeamService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private _state: TeamState = { kind: 'loading' };

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(HivemindIDESettings.AgentTreeCoordinationUrl) || e.affectsConfiguration(HivemindIDESettings.AgentTreeRepoId)) {
				this.refresh();
			}
		}));
		this.refresh();
	}

	get state(): TeamState {
		return this._state;
	}

	get hub(): { url: string; repoId: string } | undefined {
		const url = this.configurationService.getValue<string>(HivemindIDESettings.AgentTreeCoordinationUrl)?.trim();
		const repoId = this.configurationService.getValue<string>(HivemindIDESettings.AgentTreeRepoId)?.trim();
		return url && repoId ? { url, repoId } : undefined;
	}

	private tokenKey(hub: { url: string; repoId: string }): string {
		return `${TOKEN_KEY_PREFIX}${hub.url.replace(/\/+$/, '')}#${hub.repoId}`;
	}

	async client(): Promise<CoordinationClient | undefined> {
		const hub = this.hub;
		return hub && new CoordinationClient(hub.url, 5000, await this.secretStorageService.get(this.tokenKey(hub)));
	}

	private setState(state: TeamState): void {
		this._state = state;
		this._onDidChange.fire();
		this.watch();
	}

	// ---- Live updates -------------------------------------------------------------------
	//
	// While you are signed in, the hub's event stream tells us when anyone joins,
	// leaves or changes role, so the team view never needs a manual refresh. A
	// burst (forty people joining at once) becomes one refresh.

	private readonly stream = this._register(new MutableDisposable());
	private streamKey: string | undefined;
	private readonly refreshSoon = this._register(new RunOnceScheduler(() => this.refresh(), 300));

	private async watch(): Promise<void> {
		const hub = this.hub;
		if (this._state.kind !== 'signedIn' || !hub) {
			if (this._state.kind !== 'loading') {
				this.stream.clear();
				this.streamKey = undefined;
			}
			return;
		}
		const token = await this.secretStorageService.get(this.tokenKey(hub));
		const key = `${this.tokenKey(hub)}|${token}`;
		if (!token || key === this.streamKey) {
			return;
		}
		this.streamKey = key;
		// Team events only: the hub leaves out every presence and lease event.
		const url = new CoordinationClient(hub.url, 5000, token).streamUrl(hub.repoId, true);
		const store = new DisposableStore();
		this.stream.value = store;
		let socket: WebSocket;
		try {
			socket = new WebSocket(url);
		} catch {
			this.retryWatch(store);
			return;
		}
		store.add(toDisposable(() => {
			socket.onclose = null;
			try { socket.close(); } catch { /* ignore */ }
		}));
		socket.onmessage = msg => {
			if (String(msg.data).includes('"type":"team.')) {
				this.refreshSoon.schedule();
			}
		};
		socket.onclose = e => {
			if (e.code === STREAM_CLOSED_LOST_ACCESS) {
				// Removed from the team: refresh finds the token dead and signs you out here.
				this.streamKey = undefined;
				this.refresh();
			} else {
				this.retryWatch(store);
			}
		};
	}

	private retryWatch(store: DisposableStore): void {
		const handle = setTimeout(() => {
			this.streamKey = undefined;
			this.watch();
		}, 5000);
		store.add(toDisposable(() => clearTimeout(handle)));
	}

	async refresh(): Promise<void> {
		const hub = this.hub;
		if (!hub) {
			this.setState({ kind: 'unconfigured' });
			return;
		}
		const token = await this.secretStorageService.get(this.tokenKey(hub));
		const client = new CoordinationClient(hub.url, 5000, token);
		try {
			if (token) {
				this.setState({ kind: 'signedIn', view: await client.team(hub.repoId) });
				return;
			}
			// Without a token, whether the repo is gated tells whether a team exists.
			await client.presence(hub.repoId);
			this.setState({ kind: 'signedOut', hasTeam: false });
		} catch (err) {
			if (err instanceof CoordinationError && err.status === 401) {
				if (token) {
					// Removed from the team, or the token was revoked: it is no use any more.
					await this.secretStorageService.delete(this.tokenKey(hub));
				}
				this.setState({ kind: 'signedOut', hasTeam: true });
			} else if (err instanceof CoordinationError && err.code === 'no_team') {
				this.setState({ kind: 'signedOut', hasTeam: false });
			} else {
				this.setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
			}
		}
	}

	private async signIn(result: TeamSignIn): Promise<void> {
		const hub = this.hub!;
		await this.secretStorageService.set(this.tokenKey(hub), result.token);
		await this.refresh();
	}

	private async withClient<T>(run: (client: CoordinationClient, repoId: string) => Promise<T>): Promise<T> {
		const hub = this.hub;
		const client = await this.client();
		if (!hub || !client) {
			throw new Error('Set the coordination URL and repo ID first.');
		}
		try {
			return await run(client, hub.repoId);
		} finally {
			this.refresh();
		}
	}

	async createTeam(displayName: string, setupSecret?: string): Promise<void> {
		const result = await this.withClient((c, repo) => c.createTeam(repo, userIdFor(displayName), displayName, setupSecret));
		await this.signIn(result);
	}

	async joinTeam(code: string, displayName: string): Promise<void> {
		const result = await this.withClient((c, repo) => c.joinTeam(repo, code.trim(), userIdFor(displayName), displayName));
		await this.signIn(result);
	}

	async invite(role: TeamRole, ttlHours: number, maxUses: number): Promise<string> {
		return (await this.withClient((c, repo) => c.invite(repo, role, ttlHours, maxUses))).code;
	}

	async revokeInvite(inviteId: string): Promise<void> {
		await this.withClient((c, repo) => c.revokeInvite(repo, inviteId));
	}

	async setRole(userId: string, role: TeamRole): Promise<void> {
		await this.withClient((c, repo) => c.setRole(repo, userId, role));
	}

	async removeMember(userId: string): Promise<void> {
		await this.withClient((c, repo) => c.removeMember(repo, userId));
	}

	async transferOwnership(userId: string): Promise<void> {
		await this.withClient((c, repo) => c.transferOwnership(repo, userId));
	}

	async leave(): Promise<void> {
		const me = this._state.kind === 'signedIn' ? this._state.view.you.user_id : undefined;
		if (me) {
			await this.withClient((c, repo) => c.removeMember(repo, me));
			await this.signOut();
		}
	}

	async signOut(): Promise<void> {
		const hub = this.hub;
		if (hub) {
			await this.secretStorageService.delete(this.tokenKey(hub));
		}
		await this.refresh();
	}
}
