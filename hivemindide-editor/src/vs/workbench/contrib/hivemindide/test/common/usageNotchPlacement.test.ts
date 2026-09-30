/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DEFAULT_NOTCH_PLACEMENT, notchStart, parseNotchPlacement, snapNotchPlacement } from '../../common/usageNotchPlacement.js';

suite('HivemindIDE usage notch placement', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a drop snaps to the nearest edge, keeping its spot along it', () => {
		assert.deepStrictEqual([
			snapNotchPlacement(10, 400, 1200, 800),
			snapNotchPlacement(1190, 200, 1200, 800),
			snapNotchPlacement(600, 5, 1200, 800),
			snapNotchPlacement(300, 790, 1200, 800),
			snapNotchPlacement(-50, 700, 1200, 800), // dropped outside the window
		], [
			{ edge: 'left', offset: 0.5 },
			{ edge: 'right', offset: 0.25 },
			{ edge: 'top', offset: 0.5 },
			{ edge: 'bottom', offset: 0.25 },
			{ edge: 'left', offset: 0.875 },
		]);
	});

	test('the notch stays whole and clear of the corners, however small the window', () => {
		assert.deepStrictEqual([
			notchStart({ edge: 'left', offset: 0.5 }, 800, 200, 40),  // centred
			notchStart({ edge: 'left', offset: 0 }, 800, 200, 40),    // pushed off the top corner
			notchStart({ edge: 'left', offset: 1 }, 800, 200, 40),    // pushed off the bottom corner
			notchStart({ edge: 'left', offset: 0.5 }, 250, 200, 40),  // no room for margins: centre it
		], [300, 40, 560, 25]);
	});

	test('reads back what it stored, and falls back to the default otherwise', () => {
		assert.deepStrictEqual([
			parseNotchPlacement(JSON.stringify({ edge: 'top', offset: 0.3 })),
			parseNotchPlacement(JSON.stringify({ edge: 'bottom', offset: 7 })),
			parseNotchPlacement(JSON.stringify({ edge: 'middle', offset: 0.3 })),
			parseNotchPlacement('{"edge":'),
			parseNotchPlacement(undefined),
		], [
			{ edge: 'top', offset: 0.3 },
			{ edge: 'bottom', offset: 1 },
			DEFAULT_NOTCH_PLACEMENT,
			DEFAULT_NOTCH_PLACEMENT,
			DEFAULT_NOTCH_PLACEMENT,
		]);
	});
});
