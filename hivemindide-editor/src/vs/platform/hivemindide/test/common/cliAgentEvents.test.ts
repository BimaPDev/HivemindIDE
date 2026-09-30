/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { parseCliAgentLine, parseModelList, toolTitle } from '../../common/cliAgentEvents.js';

suite('HivemindIDE agent CLI output', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const parse = (agent: string, lines: object[]) => lines.flatMap(line => parseCliAgentLine(agent, JSON.stringify(line)));

	test('Claude Code stream-json: session, limit, text, tools, result', () => {
		// Shapes as Claude Code 2.1 prints them with --output-format stream-json --verbose.
		assert.deepStrictEqual(parse('claude', [
			{ type: 'system', subtype: 'init', session_id: 's-1', model: 'claude-haiku-4-5', permissionMode: 'acceptEdits' },
			{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1790587800, rateLimitType: 'five_hour' } },
			{ type: 'system', subtype: 'thinking_tokens', session_id: 's-1' },
			{ type: 'assistant', message: { content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'Reading it.' }, { type: 'tool_use', id: 't-1', name: 'Read', input: { file_path: '/w/src/notes.md' } }] } },
			{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't-1', content: '...' }] } },
			{ type: 'assistant', message: { content: [{ type: 'text', text: 'The word is lantern.' }] } },
			{ type: 'result', subtype: 'success', is_error: false, result: 'The word is lantern.', session_id: 's-1' },
		]), [
			{ kind: 'session', id: 's-1' },
			{ kind: 'limit', rejected: false, resetsAt: 1790587800, limitType: 'five_hour' },
			{ kind: 'text', text: 'Reading it.' },
			{ kind: 'tool', id: 't-1', title: 'Read: notes.md', status: 'in_progress' },
			{ kind: 'tool', id: 't-1', status: 'completed' },
			{ kind: 'text', text: 'The word is lantern.' },
			{ kind: 'done', stopReason: 'end_turn' },
		]);
	});

	test('a limit event near the limit carries its utilization', () => {
		assert.deepStrictEqual(parse('claude', [
			{ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', resetsAt: 1790587800, rateLimitType: 'seven_day', utilization: 0.82, surpassedThreshold: 0.75 } },
		]), [
			{ kind: 'limit', rejected: false, resetsAt: 1790587800, limitType: 'seven_day', utilization: 0.82 },
		]);
	});

	test('a usage limit and a failed result are reported, not swallowed', () => {
		assert.deepStrictEqual(parse('claude', [
			{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1790587800, rateLimitType: 'five_hour' } },
			{ type: 'result', subtype: 'success', is_error: true, result: 'Claude AI usage limit reached|1790587800' },
			{ type: 'result', subtype: 'error_max_turns', is_error: true },
		]), [
			{ kind: 'limit', rejected: true, resetsAt: 1790587800, limitType: 'five_hour' },
			{ kind: 'done', error: 'Claude AI usage limit reached|1790587800' },
			{ kind: 'done', stopReason: 'max_turn_requests' },
		]);
	});

	test('Cursor tool_call lines', () => {
		assert.deepStrictEqual(parse('cursor-agent', [
			{ type: 'system', subtype: 'init', session_id: 'chat-9' },
			{ type: 'tool_call', subtype: 'started', call_id: 'c-1', tool_call: { readToolCall: { args: { path: 'notes.md' } } } },
			{ type: 'tool_call', subtype: 'completed', call_id: 'c-1', tool_call: { readToolCall: { args: { path: 'notes.md' }, result: {} } } },
			{ type: 'result', subtype: 'success', is_error: false, result: 'ok' },
		]), [
			{ kind: 'session', id: 'chat-9' },
			{ kind: 'tool', id: 'c-1', title: 'read: notes.md', status: 'in_progress' },
			{ kind: 'tool', id: 'c-1', title: 'read: notes.md', status: 'completed' },
			{ kind: 'done', stopReason: 'end_turn' },
		]);
	});

	test('Codex exec --json', () => {
		assert.deepStrictEqual(parse('codex', [
			{ type: 'thread.started', thread_id: 'th-1' },
			{ type: 'item.started', item: { id: 'i-1', type: 'command_execution', command: 'ls -la' } },
			{ type: 'item.completed', item: { id: 'i-1', type: 'command_execution', command: 'ls -la', exit_code: 0 } },
			{ type: 'item.completed', item: { id: 'i-2', type: 'agent_message', text: 'Done.' } },
			{ type: 'turn.completed', usage: { input_tokens: 10 } },
			{ type: 'turn.failed', error: { message: 'You\'ve hit your usage limit.' } },
		]), [
			{ kind: 'session', id: 'th-1' },
			{ kind: 'tool', id: 'i-1', title: 'shell: ls -la', status: 'in_progress' },
			{ kind: 'tool', id: 'i-1', title: 'shell: ls -la', status: 'completed' },
			{ kind: 'text', text: 'Done.' },
			{ kind: 'done', stopReason: 'end_turn' },
			{ kind: 'done', error: 'You\'ve hit your usage limit.' },
		]);
	});

	test('garbage and unknown lines are ignored', () => {
		assert.deepStrictEqual([
			parseCliAgentLine('claude', 'not json'),
			parseCliAgentLine('claude', '{"type":"something_new"}'),
			parseCliAgentLine('codex', 'null'),
		], [[], [], []]);
	});

	test('tool titles name what the tool touches', () => {
		assert.deepStrictEqual([
			toolTitle('Bash', { command: 'npm   test' }),
			toolTitle('Edit', { file_path: '/a/b/c.ts' }),
			toolTitle('Think', undefined),
		], ['Bash: npm test', 'Edit: c.ts', 'Think']);
	});

	test('model listings', () => {
		assert.deepStrictEqual(parseModelList('Available models\n\n- auto (default)\n- gpt-5\n  sonnet-4.5-thinking   Claude\ncomposer-1\n'), ['auto', 'gpt-5', 'sonnet-4.5-thinking', 'composer-1']);
	});
});
