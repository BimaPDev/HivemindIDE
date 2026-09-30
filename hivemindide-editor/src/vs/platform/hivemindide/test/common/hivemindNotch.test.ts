/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { applyNotchStep, clampText, findNotch, INotchDisplayInfo, INotchScreenInfo, INotchSteps, NOTCH_DONE_MS, NOTCH_MAX_STEPS, NOTCH_STUCK_MS, notchPhase, parseNotchProbe } from '../../common/hivemindNotch.js';

suite('HivemindIDE MacBook notch', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	// As a 15" MacBook Air reports itself: 156 × 28 pt notch between the menu bar halves.
	const builtIn: INotchScreenInfo = { frame: { x: 0, y: 0, width: 1440, height: 932 }, safeTop: 28, leftArea: { x: 0, width: 642 }, rightArea: { x: 798, width: 642 } };
	const external: INotchScreenInfo = { frame: { x: 1440, y: 0, width: 2560, height: 1440 }, safeTop: 0, leftArea: { x: 0, width: 0 }, rightArea: { x: 0, width: 0 } };
	const displays: INotchDisplayInfo[] = [
		{ id: 1, internal: true, bounds: { x: 0, y: 0, width: 1440, height: 932 } },
		{ id: 2, internal: false, bounds: { x: 1440, y: -200, width: 2560, height: 1440 } },
	];

	test('finds the notch of the built-in display', () => {
		assert.deepStrictEqual(findNotch([external, builtIn], displays), { displayId: 1, x: 642, y: 0, width: 156, height: 28 });
	});

	test('places it on the built-in display wherever that display is', () => {
		// Built-in to the right of the external screen, its side areas given in global coordinates.
		const moved: INotchScreenInfo = { ...builtIn, frame: { ...builtIn.frame, x: 2560 }, leftArea: { x: 2560, width: 642 }, rightArea: { x: 3358, width: 642 } };
		const movedDisplays: INotchDisplayInfo[] = [{ id: 1, internal: true, bounds: { x: 2560, y: 300, width: 1440, height: 932 } }];
		assert.deepStrictEqual(findNotch([moved], movedDisplays), { displayId: 1, x: 3202, y: 300, width: 156, height: 28 });
	});

	test('no notch: an older Mac, a closed lid, or no matching display', () => {
		const flat: INotchScreenInfo = { ...builtIn, safeTop: 0 };
		assert.deepStrictEqual([
			findNotch([flat], displays),
			findNotch([external], displays),
			findNotch([builtIn], [displays[1]]),
			findNotch([], displays),
		], [undefined, undefined, undefined, undefined]);
	});

	test('the checklist keeps the latest run: titles from the start, status from the latest event', () => {
		let s: INotchSteps = { steps: [] };
		s = applyNotchStep(s, 'a', { toolCallId: '1', title: 'Read: notes.md', status: 'in_progress' });
		s = applyNotchStep(s, 'a', { toolCallId: '2', title: 'Edit: notes.md', status: 'pending' });
		s = applyNotchStep(s, 'a', { toolCallId: '1', status: 'completed' }); // CLIs send no title when a call ends
		s = applyNotchStep(s, 'a', { toolCallId: '2', title: 'ignored', status: 'failed' });
		assert.deepStrictEqual(s, { sessionId: 'a', steps: [
			{ id: '1', title: 'Read: notes.md', status: 'completed' },
			{ id: '2', title: 'Edit: notes.md', status: 'failed' },
		] });
		// A new session starts over; a long run keeps only its latest steps.
		for (let i = 0; i < 10; i++) {
			s = applyNotchStep(s, 'b', { toolCallId: String(i), title: `step ${i}` });
		}
		assert.deepStrictEqual([s.sessionId, s.steps.length, s.steps[0].title, s.steps[NOTCH_MAX_STEPS - 1].status], ['b', NOTCH_MAX_STEPS, 'step 4', 'in_progress']);
	});

	test('phase: asking first; working until the turn ends, however long a tool is silent; done for a minute; then idle', () => {
		const now = 100_000_000;
		assert.deepStrictEqual([
			notchPhase(true, true, now - 1, now),
			notchPhase(false, false, 0, now),
			notchPhase(false, true, now - 5 * 60_000, now),           // a find over the whole disk: still working
			notchPhase(false, true, now - NOTCH_STUCK_MS, now),        // no end after 15 minutes: stop claiming it works
			notchPhase(false, false, now - 1000, now),                 // just ended (the end restarts the clock)
			notchPhase(false, false, now - NOTCH_DONE_MS, now),
		], ['asking', 'idle', 'working', 'idle', 'done', 'idle']);
	});

	test('agent text is clamped before it reaches the notch', () => {
		assert.deepStrictEqual([clampText('short', 10), clampText('x'.repeat(20), 10), clampText('y'.repeat(100_000), 600).length], ['short', 'xxxxxxxxx…', 600]);
	});

	test('reads the probe output defensively', () => {
		assert.deepStrictEqual([
			parseNotchProbe(JSON.stringify([builtIn])),
			parseNotchProbe(JSON.stringify([{ frame: { x: 0 } }, builtIn])),
			parseNotchProbe('execution error: ObjC not available'),
			parseNotchProbe('{}'),
		], [[builtIn], [builtIn], [], []]);
	});
});
