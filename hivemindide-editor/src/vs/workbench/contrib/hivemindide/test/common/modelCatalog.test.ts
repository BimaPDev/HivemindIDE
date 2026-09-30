/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { catalogEntry, guessTraits, ICatalogEntry, parseTaskLabel, parseTraitOverrides, rankForTask, taskForMode } from '../../common/modelCatalog.js';

suite('HivemindIDE model catalog', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const r = (id: string) => ({ id, provider: id.split('/')[0], model: id.split('/').slice(1).join('/') });

	// A realistic machine: Claude Code, an API key, and Ollama models.
	const catalog: ICatalogEntry[] = [
		catalogEntry(r('Local/qwen2.5:1.5b'), 'local', undefined, undefined),
		catalogEntry(r('Local/gemma:2b'), 'local', { toolless: true }, undefined),
		catalogEntry(r('Claude Code/default'), 'cli', undefined, undefined, true),
		catalogEntry(r('Claude Code/opus'), 'cli', undefined, undefined),
		catalogEntry(r('Claude Code/sonnet'), 'cli', undefined, undefined),
		catalogEntry(r('Claude Code/haiku'), 'cli', undefined, undefined),
		catalogEntry(r('OpenAI/gpt-5'), 'api', undefined, undefined),
		catalogEntry(r('OpenAI/gpt-5-mini'), 'api', undefined, undefined),
	];
	const best = (task: Parameters<typeof rankForTask>[1], available?: (route: string) => boolean) => rankForTask(catalog, task, available)[0]?.entry.route;

	test('names say what a model is', () => {
		assert.deepStrictEqual({
			opus: guessTraits('claude-opus-4-5', 'api').traits,
			miniOnCli: guessTraits('gpt-5-mini', 'cli').traits,
			tinyLocal: guessTraits('qwen2.5:1.5b', 'local').traits,
			unknown: guessTraits('mystery-model', 'api'),
		}, {
			opus: { reasoning: 'high', speed: 'low', cost: 'high', tools: true, strengths: ['plan', 'code'] },
			miniOnCli: { reasoning: 'medium', speed: 'high', cost: 'subscription', tools: true, strengths: ['subagent', 'ask'] },
			tinyLocal: { reasoning: 'low', speed: 'high', cost: 'free', tools: undefined, strengths: ['summarize'] },
			unknown: { traits: { reasoning: 'medium', speed: 'medium', cost: 'medium', tools: undefined, strengths: ['ask'] }, known: false },
		});
	});

	test('each task goes to the model that suits it', () => {
		assert.deepStrictEqual({
			plan: best('plan'),
			code: best('code'),
			subagent: best('subagent'),
			summarize: best('summarize'),
			ask: best('ask'),
		}, {
			plan: 'Claude Code/opus',
			code: 'Claude Code/default',
			subagent: 'Claude Code/haiku',
			summarize: 'Local/qwen2.5:1.5b',
			ask: 'Claude Code/haiku',
		});
	});

	test('models that cannot call tools never get agent tasks; resting ones are skipped', () => {
		const agentTasks = rankForTask(catalog, 'subagent').map(x => x.entry.route);
		assert.deepStrictEqual({
			gemmaDoesAgentWork: agentTasks.includes('Local/gemma:2b'),
			gemmaCanSummarize: rankForTask(catalog, 'summarize').some(x => x.entry.route === 'Local/gemma:2b'),
			planWhileClaudeRests: best('plan', route => !route.startsWith('Claude Code/')),
		}, { gemmaDoesAgentWork: false, gemmaCanSummarize: true, planWhileClaudeRests: 'OpenAI/gpt-5' });
	});

	test('measured speed and the user\'s settings win over the guess', () => {
		const slow = catalogEntry(r('OpenAI/gpt-5-mini'), 'api', { averageMs: 45_000, successes: 5 }, undefined);
		const tooFew = catalogEntry(r('OpenAI/gpt-5-mini'), 'api', { averageMs: 45_000, successes: 1 }, undefined);
		const pinned = catalogEntry(r('OpenAI/gpt-5-mini'), 'api', { averageMs: 45_000, successes: 5 }, { speed: 'high', strengths: ['plan'] });
		assert.deepStrictEqual([
			[slow.traits.speed, slow.sources],
			[tooFew.traits.speed, tooFew.sources],
			[pinned.traits.speed, pinned.traits.strengths, pinned.sources],
		], [
			['low', ['known', 'measured']],
			['high', ['known']],
			['high', ['plan'], ['known', 'measured', 'user']],
		]);
	});

	test('modes and planner labels map to tasks', () => {
		assert.deepStrictEqual({
			modes: [taskForMode('Plan'), taskForMode('Ask'), taskForMode('Agent'), taskForMode(undefined), taskForMode('Architect')],
			labels: ['[code] Add the endpoint', '[research] Find how auth works', '[summarize] Write release notes', 'No label here'].map(parseTaskLabel),
		}, {
			modes: ['plan', 'ask', 'code', 'code', 'plan'],
			labels: [
				{ kind: 'subagent', text: 'Add the endpoint' },
				{ kind: 'ask', text: 'Find how auth works' },
				{ kind: 'summarize', text: 'Write release notes' },
				{ kind: 'subagent', text: 'No label here' },
			],
		});
	});

	test('overrides are read defensively', () => {
		assert.deepStrictEqual(parseTraitOverrides({
			'OpenAI/gpt-5': { reasoning: 'high', speed: 'warp', tools: 'yes', strengths: ['plan', 'dance'] },
			'X/y': 'nonsense',
			'Z/z': {},
		}), { 'OpenAI/gpt-5': { reasoning: 'high', strengths: ['plan'] } });
	});
});
