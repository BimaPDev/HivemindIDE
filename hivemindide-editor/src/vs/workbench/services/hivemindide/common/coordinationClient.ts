/*---------------------------------------------------------------------------
 *  Client for coordinationd: leases, heartbeats, the presence stream, and teams.
 *
 *  Mirrored from the services repo's fork/integration/coordinationClient.ts.
 *
 *  A repo with a team needs a member's token on every call; pass it to the
 *  constructor. It goes in the Authorization header, and in the stream URL
 *  (browsers open WebSockets without custom headers).
 *--------------------------------------------------------------------------*/

export type LeaseState = 'granted' | 'denied' | 'queued';
export type SessionKind = 'human' | 'agent';

export interface Lease {
	readonly path: string;
	readonly session_id: string;
	readonly expires_at: string;
}

export interface Holder {
	readonly session_id: string;
	readonly user_id?: string;
	readonly display_name?: string;
	readonly kind?: SessionKind;
	readonly current_path?: string;
	readonly expires_at?: string;
}

export interface LeaseResponse {
	readonly state: LeaseState;
	readonly lease?: Lease;
	readonly holder?: Holder;
	readonly position?: number;
}

export interface PresenceSession {
	readonly session_id: string;
	readonly user_id: string;
	readonly display_name: string;
	readonly kind: SessionKind;
	readonly current_path: string;
	readonly last_seen: string;
}

export interface PresenceSnapshot {
	readonly sessions: readonly PresenceSession[];
	readonly leases: readonly Lease[];
}

export type TeamRole = 'owner' | 'admin' | 'member';

export interface TeamMember {
	readonly user_id: string;
	readonly display_name: string;
	readonly role: TeamRole;
	readonly joined_at: string;
	readonly invited_by?: string;
}

export interface TeamInvite {
	readonly id: string;
	readonly role: TeamRole;
	readonly created_by: string;
	readonly created_at: string;
	readonly expires_at: string;
	readonly max_uses: number;
	readonly uses: number;
}

export interface TeamView {
	readonly you: TeamMember;
	readonly members: readonly TeamMember[];
	/** Only owners and admins see pending invites. */
	readonly invites?: readonly TeamInvite[];
}

/** A sign-in: the member, and a token that is shown only this once. */
export interface TeamSignIn {
	readonly member: TeamMember;
	readonly token: string;
}

/** A failed call, with the hub's error code (`unauthorized`, `forbidden`, `no_team`, ...). */
export class CoordinationError extends Error {
	constructor(readonly status: number, readonly code: string, message: string) {
		super(message);
	}
}

export interface StreamEvent {
	readonly type: string;
	readonly at: string;
	readonly data?: unknown;
}

/** How often the fork heartbeats. The server expires presence at 45s. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

export class CoordinationClient {
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly token: string | undefined;

	constructor(baseUrl = 'http://127.0.0.1:8082', timeoutMs = 3000, token?: string) {
		this.baseUrl = baseUrl.replace(/\/$/, '');
		this.timeoutMs = timeoutMs;
		this.token = token;
	}

	async requestLease(repoId: string, sessionId: string, path: string, ttlSeconds = 120, wait = false): Promise<LeaseResponse> {
		return this.post<LeaseResponse>('/v1/leases/request', {
			repo_id: repoId, session_id: sessionId, path, ttl_seconds: ttlSeconds, wait,
		});
	}

	async releaseLease(repoId: string, sessionId: string, path: string): Promise<boolean> {
		const res = await this.post<{ released: boolean }>('/v1/leases/release', {
			repo_id: repoId, session_id: sessionId, path,
		});
		return res.released;
	}

	async heartbeat(repoId: string, session: {
		sessionId: string; userId: string; displayName: string;
		kind: SessionKind; currentPath: string;
	}): Promise<void> {
		await this.post('/v1/presence/heartbeat', {
			repo_id: repoId,
			session_id: session.sessionId,
			user_id: session.userId,
			display_name: session.displayName,
			kind: session.kind,
			current_path: session.currentPath,
		});
	}

	async presence(repoId: string): Promise<PresenceSnapshot> {
		return this.call<PresenceSnapshot>('GET', `/v1/presence/${encodeURIComponent(repoId)}`);
	}

	/** `onlyTeam`: the hub sends team events only (joins, removals, role changes), none of the presence traffic. */
	streamUrl(repoId: string, onlyTeam?: boolean): string {
		const url = new URL(`${this.baseUrl.replace(/^http/, 'ws')}/v1/presence/${encodeURIComponent(repoId)}/stream`);
		if (this.token) {
			url.searchParams.set('access_token', this.token);
		}
		if (onlyTeam) {
			url.searchParams.set('only', 'team');
		}
		return url.toString();
	}

	// ---- Teams: only owners and admins share ------------------------------------

	/** Makes a team for the repo with the caller as owner. `setupSecret` when the hub requires one. */
	createTeam(repoId: string, userId: string, displayName: string, setupSecret?: string): Promise<TeamSignIn> {
		return this.call('POST', `/v1/teams/${encodeURIComponent(repoId)}`, { user_id: userId, display_name: displayName }, setupSecret ? { 'X-Hivemind-Setup-Secret': setupSecret } : undefined);
	}

	team(repoId: string): Promise<TeamView> {
		return this.call('GET', `/v1/teams/${encodeURIComponent(repoId)}`);
	}

	joinTeam(repoId: string, code: string, userId: string, displayName: string): Promise<TeamSignIn> {
		return this.call('POST', `/v1/teams/${encodeURIComponent(repoId)}/join`, { code, user_id: userId, display_name: displayName });
	}

	/** Returns the one-time code to pass to the invitee. */
	invite(repoId: string, role: TeamRole, ttlHours: number, maxUses: number): Promise<{ readonly invite: TeamInvite; readonly code: string }> {
		return this.call('POST', `/v1/teams/${encodeURIComponent(repoId)}/invites`, { role, ttl_hours: ttlHours, max_uses: maxUses });
	}

	revokeInvite(repoId: string, inviteId: string): Promise<unknown> {
		return this.call('DELETE', `/v1/teams/${encodeURIComponent(repoId)}/invites/${encodeURIComponent(inviteId)}`);
	}

	setRole(repoId: string, userId: string, role: TeamRole): Promise<TeamMember> {
		return this.call('PATCH', `/v1/teams/${encodeURIComponent(repoId)}/members/${encodeURIComponent(userId)}`, { role });
	}

	/** Removing yourself is leaving. */
	removeMember(repoId: string, userId: string): Promise<unknown> {
		return this.call('DELETE', `/v1/teams/${encodeURIComponent(repoId)}/members/${encodeURIComponent(userId)}`);
	}

	transferOwnership(repoId: string, userId: string): Promise<TeamMember> {
		return this.call('POST', `/v1/teams/${encodeURIComponent(repoId)}/transfer`, { user_id: userId });
	}

	private post<T>(path: string, body: unknown): Promise<T> {
		return this.call<T>('POST', path, body);
	}

	private async call<T>(method: string, path: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<T> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
			if (this.token) {
				headers.Authorization = `Bearer ${this.token}`;
			}
			const res = await fetch(`${this.baseUrl}${path}`, {
				method,
				headers,
				body: body === undefined ? undefined : JSON.stringify(body),
				signal: controller.signal,
			});
			if (!res.ok) {
				const text = await res.text();
				let code = 'http_error';
				let message = text.slice(0, 200);
				try {
					const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
					code = parsed.error?.code ?? code;
					message = parsed.error?.message ?? message;
				} catch {
					// not the hub's error shape
				}
				throw new CoordinationError(res.status, code, message);
			}
			return await res.json() as T;
		} finally {
			clearTimeout(timer);
		}
	}
}

export function describeDenial(res: LeaseResponse, path: string): string {
	const who = res.holder?.display_name ?? res.holder?.session_id ?? 'another session';
	const kind = res.holder?.kind === 'agent' ? ' (an agent)' : '';

	if (res.state === 'queued') {
		return `${path} is held by ${who}${kind}. You are #${res.position ?? 1} in the queue and will get it when they release.`;
	}

	let line = `${path} is held by ${who}${kind}, so this save was blocked.`;
	if (res.holder?.expires_at) {
		const secs = Math.max(0, Math.round((Date.parse(res.holder.expires_at) - Date.now()) / 1000));
		line += ` Their lease expires in ${secs}s.`;
	}
	return line;
}
