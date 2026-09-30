/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE hivemind shell: reading the headless output of agent CLIs.
 *
 *  Each CLI prints one JSON object per line. These parsers turn a line into
 *  the few things the shell needs, so the runner does not care which CLI it
 *  runs. Pure functions: unknown lines and fields are ignored, because these
 *  formats are not a stable contract and gain fields between releases.
 *
 *  - Claude Code: `claude -p --output-format stream-json --verbose`
 *  - Cursor:      `cursor-agent -p --output-format stream-json` (same shape, plus tool_call lines)
 *  - Codex:       `codex exec --json`
 *--------------------------------------------------------------------------------------------*/

import { HivemindShellStopReason } from './hivemindShell.js';

export type CliAgentEvent =
	/** The CLI's own session id, to resume with. */
	| { readonly kind: 'session'; readonly id: string }
	| { readonly kind: 'text' | 'thought'; readonly text: string }
	| { readonly kind: 'tool'; readonly id: string; readonly title?: string; readonly status: 'in_progress' | 'completed' | 'failed' }
	/**
	 * Usage-limit state the CLI reported. `resetsAt` is in seconds since the epoch.
	 * `utilization` is a fraction (0–1) of the window used; Claude Code only sends it
	 * once usage nears the limit.
	 */
	| { readonly kind: 'limit'; readonly rejected: boolean; readonly resetsAt?: number; readonly limitType?: string; readonly utilization?: number }
	/** The turn ended; `error` when it failed. */
	| { readonly kind: 'done'; readonly error?: string; readonly stopReason?: HivemindShellStopReason };

type Json = Record<string, unknown>;

export function parseCliAgentLine(agent: string, line: string): CliAgentEvent[] {
	let event: Json;
	try {
		event = JSON.parse(line);
	} catch {
		return [];
	}
	if (typeof event !== 'object' || event === null) {
		return [];
	}
	return agent === 'codex' ? parseCodex(event) : parseStreamJson(event);
}

/** Claude Code's stream-json, which Cursor's follows. */
function parseStreamJson(event: Json): CliAgentEvent[] {
	switch (event.type) {
		case 'system':
			return event.subtype === 'init' && typeof event.session_id === 'string' ? [{ kind: 'session', id: event.session_id }] : [];
		case 'rate_limit_event': {
			const info = (event.rate_limit_info ?? {}) as Json;
			return [{
				kind: 'limit',
				rejected: info.status === 'rejected',
				resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : undefined,
				limitType: typeof info.rateLimitType === 'string' ? info.rateLimitType : undefined,
				// Absent while usage is comfortably below the limit; leave it out rather than send undefined.
				...(typeof info.utilization === 'number' ? { utilization: info.utilization } : {}),
			}];
		}
		case 'assistant': {
			const events: CliAgentEvent[] = [];
			for (const block of contentOf(event)) {
				if (block.type === 'text' && typeof block.text === 'string' && block.text) {
					events.push({ kind: 'text', text: block.text });
				} else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking) {
					events.push({ kind: 'thought', text: block.thinking });
				} else if (block.type === 'tool_use' && typeof block.id === 'string') {
					events.push({ kind: 'tool', id: block.id, title: toolTitle(String(block.name ?? 'tool'), block.input as Json | undefined), status: 'in_progress' });
				}
			}
			return events;
		}
		case 'user':
			return contentOf(event)
				.filter(block => block.type === 'tool_result' && typeof block.tool_use_id === 'string')
				.map(block => ({ kind: 'tool', id: block.tool_use_id as string, status: block.is_error ? 'failed' : 'completed' }));
		case 'tool_call': {
			// Cursor: { subtype: started|completed, call_id, tool_call: { readToolCall: { args: {...} } } }
			const call = (event.tool_call ?? {}) as Json;
			const [key] = Object.keys(call);
			const args = ((call[key] as Json | undefined)?.args ?? {}) as Json;
			const id = typeof event.call_id === 'string' ? event.call_id : key ?? 'tool';
			return [{ kind: 'tool', id, title: toolTitle((key ?? 'tool').replace(/ToolCall$/, ''), args), status: event.subtype === 'completed' ? 'completed' : 'in_progress' }];
		}
		case 'result': {
			if (!event.is_error && event.subtype !== 'error') {
				return [{ kind: 'done', stopReason: 'end_turn' }];
			}
			if (event.subtype === 'error_max_turns') {
				return [{ kind: 'done', stopReason: 'max_turn_requests' }];
			}
			const errors = Array.isArray(event.errors) ? event.errors.join('; ') : '';
			return [{ kind: 'done', error: String(event.result || errors || event.subtype || 'The CLI reported an error.') }];
		}
		default:
			return [];
	}
}

function parseCodex(event: Json): CliAgentEvent[] {
	const item = (event.item ?? {}) as Json;
	switch (event.type) {
		case 'thread.started':
			return typeof event.thread_id === 'string' ? [{ kind: 'session', id: event.thread_id }] : [];
		case 'item.started':
		case 'item.updated':
		case 'item.completed': {
			const done = event.type === 'item.completed';
			const id = String(item.id ?? 'item');
			switch (item.type) {
				case 'agent_message':
					return done && typeof item.text === 'string' ? [{ kind: 'text', text: item.text }] : [];
				case 'reasoning':
					return done && typeof item.text === 'string' ? [{ kind: 'thought', text: item.text }] : [];
				case 'command_execution':
					return [{ kind: 'tool', id, title: toolTitle('shell', { command: item.command }), status: !done ? 'in_progress' : item.exit_code === 0 || item.status === 'completed' ? 'completed' : 'failed' }];
				case 'file_change':
				case 'mcp_tool_call':
				case 'web_search':
					return [{ kind: 'tool', id, title: String(item.type).replace(/_/g, ' '), status: done ? 'completed' : 'in_progress' }];
				default:
					return [];
			}
		}
		case 'turn.completed':
			return [{ kind: 'done', stopReason: 'end_turn' }];
		case 'turn.failed':
			return [{ kind: 'done', error: String(((event.error ?? {}) as Json).message ?? 'The turn failed.') }];
		case 'error':
			return [{ kind: 'done', error: String(event.message ?? 'The CLI reported an error.') }];
		default:
			return [];
	}
}

function contentOf(event: Json): Json[] {
	const content = ((event.message ?? {}) as Json).content;
	return Array.isArray(content) ? content.filter((c): c is Json => typeof c === 'object' && c !== null) : [];
}

/** "Read notes.md", "Bash: npm test": the tool and the one argument that says what it touches. */
export function toolTitle(name: string, input: Json | undefined): string {
	const target = input && [input.file_path, input.path, input.command, input.pattern, input.url, input.query].find(v => typeof v === 'string' && v);
	if (!target) {
		return name;
	}
	const text = String(target).replace(/\s+/g, ' ').trim();
	const short = /[/\\]/.test(text) && !/\s/.test(text) ? text.split(/[/\\]/).pop()! : text;
	return `${name}: ${short.length > 60 ? `${short.slice(0, 59)}…` : short}`;
}

/** Model ids from a CLI's model listing: the first word of each line that looks like one. */
export function parseModelList(output: string): string[] {
	const ids = output.split('\n')
		.map(line => /^\s*(?:[-*•]\s*)?(?<id>[a-z0-9][a-z0-9.\-_:]*[a-z0-9])(?:\s|$)/i.exec(line)?.groups?.id)
		.filter((id): id is string => !!id && !/^(available|models?|error|usage|you|no)$/i.test(id));
	return [...new Set(ids)];
}
