/*---------------------------------------------------------------------------
 *  Client for permissiond. Lives in the fork's core, not in an extension.
 *
 *  Drop target: src/vs/workbench/services/hivemindide/common/permissionClient.ts
 *--------------------------------------------------------------------------*/

export type AccessLevel = 'read' | 'write' | 'none';
export type Intent = 'read' | 'write';

export interface PermissionRule {
	readonly pattern: string;
	readonly access_level: AccessLevel;
}

export interface DeniedPath {
	readonly path: string;
	/** Written to be shown to a human verbatim. Do not rewrite it in the UI. */
	readonly reason: string;
	readonly matched_rule: PermissionRule | null;
}

export interface FilterResult {
	readonly allowed: readonly string[];
	readonly denied: readonly DeniedPath[];
}

export interface PermissionClientOptions {
	readonly baseUrl?: string;
	/** The filter sits in front of a model call, so it must not hang the panel. */
	readonly timeoutMs?: number;
}

export class PermissionUnavailableError extends Error {
	constructor(cause: string) {
		super(`the permission service is unreachable (${cause})`);
		this.name = 'PermissionUnavailableError';
	}
}

export class PermissionClient {
	private readonly baseUrl: string;
	private readonly timeoutMs: number;

	constructor(options: PermissionClientOptions = {}) {
		this.baseUrl = (options.baseUrl ?? 'http://127.0.0.1:8081').replace(/\/$/, '');
		this.timeoutMs = options.timeoutMs ?? 3000;
	}

	/**
	 * Narrows a set of paths to the ones this user's role permits.
	 *
	 * Throws rather than returning a partial result when the service cannot be
	 * reached. The caller must treat that as "send nothing": a filter that fails
	 * open is not a filter. See failClosed() for the intended call shape.
	 */
	async filter(userId: string, repoId: string, paths: readonly string[], intent: Intent = 'read'): Promise<FilterResult> {
		if (paths.length === 0) {
			return { allowed: [], denied: [] };
		}

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await fetch(`${this.baseUrl}/v1/context/filter`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ user_id: userId, repo_id: repoId, intent, paths }),
				signal: controller.signal,
			});

			if (!res.ok) {
				const body = await res.text();
				throw new PermissionUnavailableError(`HTTP ${res.status}: ${body.slice(0, 200)}`);
			}
			return await res.json() as FilterResult;
		} catch (err) {
			if (err instanceof PermissionUnavailableError) {
				throw err;
			}
			const reason = err instanceof Error ? err.message : String(err);
			throw new PermissionUnavailableError(reason);
		} finally {
			clearTimeout(timer);
		}
	}
}

/**
 * The shape every caller in the fork should use.
 *
 * If the service is down, nothing is sent to the model and the user is told why.
 * Returning the unfiltered paths here would quietly turn the whole feature off
 * the moment a localhost service hiccuped, which is the failure mode most worth
 * designing against.
 */
export async function failClosed(
	client: PermissionClient,
	userId: string,
	repoId: string,
	paths: readonly string[],
	intent: Intent = 'read',
): Promise<FilterResult> {
	try {
		return await client.filter(userId, repoId, paths, intent);
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			allowed: [],
			denied: paths.map(path => ({
				path,
				reason: `context was withheld: ${reason}`,
				matched_rule: null,
			})),
		};
	}
}
