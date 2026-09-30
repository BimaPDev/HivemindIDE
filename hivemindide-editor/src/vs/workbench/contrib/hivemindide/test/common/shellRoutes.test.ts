/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { parseFailoverProviders } from '../../common/providerFailover.js';
import { buildShellOverlay, findRouteChoice, routeIdFromModelIdentifier, shellModelIdentifier, shellRoutes } from '../../common/shellRoutes.js';

suite('HivemindIDE shell routes', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const providers = parseFailoverProviders([
		{ name: 'OpenAI', url: 'https://api.openai.com/v1/', model: 'gpt-5', models: ['gpt-5-mini', 'gpt-5'] },
		{ name: 'Local', url: 'http://127.0.0.1:8080', model: 'qwen' },
	]);

	test('every provider model is a route, in the user\'s order, without duplicates', () => {
		assert.deepStrictEqual(shellRoutes(providers).map(r => r.id), ['OpenAI/gpt-5', 'OpenAI/gpt-5-mini', 'Local/qwen']);
	});

	test('the overlay declares routes and names key variables, but holds no keys', () => {
		const [first] = shellRoutes(providers);
		const { overlay, keyVariables } = buildShellOverlay(providers, first);
		assert.deepStrictEqual({ overlay, keyVariables: [...keyVariables] }, {
			overlay: [
				{
					id: 'llm-pi-ai', config: {
						providers: {
							OpenAI: { displayName: 'OpenAI', api: 'openai-completions', baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'HIVE_ROUTE_KEY_0', models: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }] },
							Local: { displayName: 'Local', api: 'openai-completions', baseURL: 'http://127.0.0.1:8080/v1', apiKeyEnv: 'HIVE_ROUTE_KEY_1', models: [{ id: 'qwen' }] },
						}
					}
				},
				{ id: 'acp', config: { provider: 'OpenAI', model: 'gpt-5' } },
				{ id: 'agent-default-model', config: { provider: 'OpenAI', model: 'gpt-5' } },
			],
			keyVariables: [['OpenAI', 'HIVE_ROUTE_KEY_0'], ['Local', 'HIVE_ROUTE_KEY_1']],
		});
	});

	test('finds the runtime\'s opaque value for a route', () => {
		// The encoding the runtime uses today, and a display-name fallback.
		const choices = [
			{ value: '["OpenAI","gpt-5"]', name: 'gpt-5' },
			{ value: '["Local","qwen"]', name: 'qwen' },
			{ value: 'opaque-1', name: 'gpt-5-mini', group: 'OpenAI' },
		];
		const [gpt5, mini, qwen] = shellRoutes(providers);
		assert.deepStrictEqual([findRouteChoice(choices, gpt5), findRouteChoice(choices, mini), findRouteChoice(choices, qwen), findRouteChoice([], qwen)], ['["OpenAI","gpt-5"]', 'opaque-1', '["Local","qwen"]', undefined]);
	});

	test('model picker identifiers round-trip', () => {
		const [route] = shellRoutes(providers);
		assert.deepStrictEqual([
			routeIdFromModelIdentifier(shellModelIdentifier(route)),
			routeIdFromModelIdentifier(shellModelIdentifier(route, 'service')),
			routeIdFromModelIdentifier('hivemind-cli/Claude Code/opus'),
			routeIdFromModelIdentifier('hivemindide-local/gguf-1'),
			routeIdFromModelIdentifier(undefined),
		], ['OpenAI/gpt-5', 'OpenAI/gpt-5', 'Claude Code/opus', undefined, undefined]);
	});
});
