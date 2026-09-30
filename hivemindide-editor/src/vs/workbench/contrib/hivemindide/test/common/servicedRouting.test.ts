/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { averageMs, ComboStrategy, IComboContext, IRouteStats, orderComboTargets, parseCombos, recordOutcome } from '../../common/servicedRouting.js';

suite('HivemindIDE Serviced AI routing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const routes = ['A/a', 'B/b', 'C/c'];
	const combo = (strategy: ComboStrategy, weights?: number[]) => ({ name: 'c', strategy, targets: routes.map((route, i) => weights ? { route, weight: weights[i] } : { route }) });
	const ctx = (over: Partial<IComboContext> = {}): IComboContext => ({ stats: () => undefined, available: () => true, turn: 0, random: () => 0, ...over });

	test('each strategy puts the right target first, and keeps the rest as fallbacks', () => {
		const stats: Record<string, IRouteStats> = {
			'A/a': { requests: 9, failures: 0, okMs: 9000 },   // 1.0s
			'B/b': { requests: 2, failures: 0, okMs: 600 },    // 0.3s
			'C/c': { requests: 5, failures: 5, okMs: 0 },      // never succeeded
		};
		assert.deepStrictEqual({
			priority: orderComboTargets(combo('priority'), ctx()),
			roundRobinTurn4: orderComboTargets(combo('round-robin'), ctx({ turn: 4 })),
			weightedLate: orderComboTargets(combo('weighted', [1, 1, 8]), ctx({ random: () => 0.5 })),
			weightedEarly: orderComboTargets(combo('weighted', [1, 1, 8]), ctx({ random: () => 0.05 })),
			randomReversed: orderComboTargets(combo('random'), ctx({ random: () => 0 })),
			leastUsed: orderComboTargets(combo('least-used'), ctx({ stats: r => stats[r] })),
			fastest: orderComboTargets(combo('fastest'), ctx({ stats: r => stats[r] })),
			lastGood: orderComboTargets(combo('last-good'), ctx({ lastGood: 'C/c' })),
			lastGoodUnknown: orderComboTargets(combo('last-good'), ctx({ lastGood: 'Z/z' })),
		}, {
			priority: ['A/a', 'B/b', 'C/c'],
			roundRobinTurn4: ['B/b', 'C/c', 'A/a'],
			weightedLate: ['C/c', 'A/a', 'B/b'],
			weightedEarly: ['A/a', 'B/b', 'C/c'],
			randomReversed: ['B/b', 'C/c', 'A/a'],
			leastUsed: ['B/b', 'C/c', 'A/a'],
			fastest: ['B/b', 'A/a', 'C/c'],
			lastGood: ['C/c', 'A/a', 'B/b'],
			lastGoodUnknown: ['A/a', 'B/b', 'C/c'],
		});
	});

	test('resting targets are tried last, not skipped', () => {
		assert.deepStrictEqual(orderComboTargets(combo('priority'), ctx({ available: r => r !== 'A/a' })), ['B/b', 'C/c', 'A/a']);
	});

	test('usage is recorded per outcome', () => {
		let s = recordOutcome(undefined, true, 1000, 1);
		s = recordOutcome(s, false, 50, 2, 'HTTP 429: slow down');
		s = recordOutcome(s, true, 3000, 3);
		assert.deepStrictEqual({ s, avg: averageMs(s) }, { s: { requests: 3, failures: 1, okMs: 4000, lastUsed: 3, lastError: 'HTTP 429: slow down' }, avg: 2000 });
	});

	test('combos are read defensively', () => {
		assert.deepStrictEqual(parseCombos([
			{ name: ' coding ', strategy: 'fastest', targets: ['A/a', { route: 'B/b', weight: 3 }, { route: '' }, 7] },
			{ name: 'coding', strategy: 'priority', targets: [] },
			{ name: 'odd', strategy: 'telepathy', targets: [{ route: 'C/c', weight: -1 }] },
			'nonsense',
		]), [
			{ name: 'coding', strategy: 'fastest', targets: [{ route: 'A/a' }, { route: 'B/b', weight: 3 }] },
			{ name: 'odd', strategy: 'priority', targets: [{ route: 'C/c' }] },
		]);
	});
});
