/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { availableFallbacks, classifyProviderError, isToolSupportError, parseFailoverProviders, parseRetryAfter, ProviderCooldowns, ProviderFailureKind, toFailoverMode } from '../../common/providerFailover.js';

suite('HivemindIDE provider failover', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('classifies the errors providers actually send', () => {
		const cases: [string, ProviderFailureKind][] = [
			// OpenAI reports an empty balance as a 429; the wording, not the status, says quota.
			['The model server returned HTTP 429: {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"insufficient_quota"}}', ProviderFailureKind.Quota],
			['The model server returned HTTP 400: {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}', ProviderFailureKind.Quota],
			['The model server returned HTTP 402: {"error":{"message":"Insufficient credits"}}', ProviderFailureKind.Quota],
			['The model server returned HTTP 429 (retry after 20s): {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', ProviderFailureKind.RateLimit],
			// Gemini calls a per-minute limit a quota; it is still a short wait.
			['The model server returned HTTP 429: Quota exceeded for metric: generate_content_free_tier_requests, limit: 15 per minute', ProviderFailureKind.RateLimit],
			['The model server returned HTTP 429: RESOURCE_EXHAUSTED', ProviderFailureKind.Quota],
			['The model server returned HTTP 429: ', ProviderFailureKind.RateLimit],
			['The model server returned HTTP 401: {"error":{"message":"Incorrect API key provided"}}', ProviderFailureKind.Auth],
			// An agent CLI that is not signed in, as the shell reports it.
			['Claude Code is not signed in on this machine: run `claude` in a terminal and type /login, then try again. (Not logged in · Please run /login)', ProviderFailureKind.Auth],
			['The model server returned HTTP 529: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', ProviderFailureKind.Unavailable],
			['The model server returned HTTP 503: Service Unavailable', ProviderFailureKind.Unavailable],
			['The model server returned HTTP 400: {"error":{"message":"This model\'s maximum context length is 128000 tokens."}}', ProviderFailureKind.Other],
			// A service that cannot be reached rests like one that is down.
			['Lost the connection to the remote server (http://10.0.0.2:8080): fetch failed', ProviderFailureKind.Unavailable],
			['Internal error: turn failed: Connection error.', ProviderFailureKind.Unavailable],
			['The model server returned HTTP 400: invalid model name', ProviderFailureKind.Other],
		];
		assert.deepStrictEqual(cases.map(([message]) => classifyProviderError(message).kind), cases.map(([, kind]) => kind));
	});

	test('recognizes a model that cannot call tools, and nothing else', () => {
		assert.deepStrictEqual([
			'Internal error: turn failed: 400: {"message":"registry.ollama.ai/library/gemma:2b does not support tools"}',
			'The model server returned HTTP 500: tools param requires --jinja flag',
			'HTTP 400: Tool use is not supported for this model',
			'HTTP 429: rate limit exceeded',
			'HTTP 400: maximum context length',
		].map(isToolSupportError), [true, true, true, false, false]);
	});

	test('reads the wait a provider asked for', () => {
		assert.deepStrictEqual([
			'HTTP 429 (retry after 20s): slow down',
			'Rate limit reached. Please try again in 1m30s.',
			'Please try again in 20.5s.',
			'Please try again in 450ms.',
			'HTTP 429: no hint',
		].map(parseRetryAfter), [20_000, 90_000, 20_500, 450, undefined]);
	});

	test('cooldowns skip a provider until its wait is over', () => {
		const cooldowns = new ProviderCooldowns();
		const providers = parseFailoverProviders([
			{ name: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-5' },
			{ name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', model: 'some/model' },
			{ name: 'Local', url: 'http://127.0.0.1:8080', model: 'qwen' },
		]);
		cooldowns.mark('OpenAI', classifyProviderError('HTTP 429 (retry after 60s): rate limit'), 0);
		const names = (now: number, tried: string[] = []) => availableFallbacks(providers, new Set(tried), cooldowns, now).map(p => p.name);
		assert.deepStrictEqual(
			[names(30_000), names(30_000, ['OpenRouter']), names(60_000)],
			[['OpenRouter', 'Local'], ['Local'], ['OpenAI', 'OpenRouter', 'Local']],
		);
	});

	test('a failure that is not about the provider puts nothing on hold', () => {
		const cooldowns = new ProviderCooldowns();
		cooldowns.mark('OpenAI', classifyProviderError('HTTP 400: maximum context length'), 0);
		assert.deepStrictEqual(cooldowns.active(0), []);
	});

	test('settings are read defensively', () => {
		assert.deepStrictEqual([
			parseFailoverProviders([
				{ name: ' A ', url: 'https://a/v1', model: 'm' },
				{ name: 'A', url: 'https://duplicate/v1', model: 'm' },
				{ name: 'B', url: '', model: 'm' },
				'nonsense',
			]),
			parseFailoverProviders(undefined),
			[toFailoverMode('auto'), toFailoverMode('off'), toFailoverMode('bogus'), toFailoverMode(undefined)],
		], [
			[{ name: 'A', url: 'https://a/v1', model: 'm' }],
			[],
			['auto', 'off', 'ask', 'ask'],
		]);
	});
});
