/*---------------------------------------------------------------------------
 *  Client for coordinationd: leases, heartbeats and the presence stream.
 *
 *  Mirrored from the services repo's fork/integration/coordinationClient.ts.
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

	constructor(baseUrl = 'http://127.0.0.1:8082', timeoutMs = 3000) {
		this.baseUrl = baseUrl.replace(/\/$/, '');
		this.timeoutMs = timeoutMs;
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
		const res = await fetch(`${this.baseUrl}/v1/presence/${encodeURIComponent(repoId)}`);
		if (!res.ok) {
			throw new Error(`presence: HTTP ${res.status}`);
		}
		return await res.json() as PresenceSnapshot;
	}

	streamUrl(repoId: string): string {
		return `${this.baseUrl.replace(/^http/, 'ws')}/v1/presence/${encodeURIComponent(repoId)}/stream`;
	}

	private async post<T>(path: string, body: unknown): Promise<T> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await fetch(`${this.baseUrl}${path}`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!res.ok) {
				throw new Error(`${path}: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
