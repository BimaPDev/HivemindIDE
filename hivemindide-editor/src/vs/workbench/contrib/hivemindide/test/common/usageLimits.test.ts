/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyClaudeLimit, formatResets, headlineWindow, IAlertMark, IProviderLimits, IUsageWindow, nextAlert, parseCodexRateLimits, severityOf, toThresholds, windowLabelForMinutes } from '../../common/usageLimits.js';

suite('HivemindIDE usage limits', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const at = Date.parse('2026-09-28T10:00:00.000Z');
	const line = (rateLimits: object, timestamp = '2026-09-28T10:00:00.000Z') => JSON.stringify({ timestamp, type: 'event_msg', payload: { type: 'token_count', info: null, rate_limits: rateLimits } });

	test('reads every shape Codex has written its rate limits in', () => {
		assert.deepStrictEqual([
			// Current: nested windows, reset as epoch seconds.
			line({ primary: { used_percent: 21, window_minutes: 300, resets_at: at / 1000 + 3060 }, secondary: { used_percent: 7.5, window_minutes: 10080, resets_at: at / 1000 + 86400 } }),
			// Earlier: reset relative to the line's timestamp.
			line({ primary: { used_percent: 52, window_minutes: 299, resets_in_seconds: 600 } }),
			// Earliest: flat fields, no reset time.
			line({ primary_used_percent: 130, secondary_used_percent: 3, primary_window_minutes: 300, secondary_window_minutes: 10080 }),
		].map(parseCodexRateLimits), [
			{ observedAt: at, windows: [{ id: 'primary', label: '5-hour limit', usedPercent: 21, resetsAt: at + 3060_000 }, { id: 'secondary', label: 'Weekly limit', usedPercent: 7.5, resetsAt: at + 86400_000 }] },
			{ observedAt: at, windows: [{ id: 'primary', label: '5-hour limit', usedPercent: 52, resetsAt: at + 600_000 }] },
			{ observedAt: at, windows: [{ id: 'primary', label: '5-hour limit', usedPercent: 100, resetsAt: undefined }, { id: 'secondary', label: 'Weekly limit', usedPercent: 3, resetsAt: undefined }] },
		]);
	});

	test('ignores Codex lines that carry no snapshot', () => {
		assert.deepStrictEqual([
			JSON.stringify({ timestamp: '2026-09-28T10:00:00Z', type: 'response_item', payload: { type: 'message' } }),
			line(null as unknown as object),
			line({ primary: { window_minutes: 300 } }),
			'{"timestamp": "2026-09-28T10:00:00Z", "payload": {"type": "token_count", "rate_limits": ', // cut by the tail read
			'not json',
		].map(parseCodexRateLimits), [undefined, undefined, undefined, undefined, undefined]);
	});

	test('labels windows by length, allowing for the minute Codex rounds off', () => {
		assert.deepStrictEqual([299, 300, 60, 1440, 10079, 10080, 43200].map(windowLabelForMinutes),
			['5-hour limit', '5-hour limit', '1-hour limit', 'Daily limit', 'Weekly limit', 'Weekly limit', '30-day limit']);
	});

	test('Claude Code limit events: percent when reported, carried while the window lasts, full when refused', () => {
		const resetsAt = at / 1000 + 3000;
		let windows: IUsageWindow[] = [];
		const steps: (number | undefined)[] = [];
		for (const report of [
			{ rejected: false, limitType: 'five_hour', resetsAt },                        // allowed: no figure yet
			{ rejected: false, limitType: 'five_hour', resetsAt, utilization: 0.82 },     // allowed_warning
			{ rejected: false, limitType: 'five_hour', resetsAt: resetsAt + 20 },         // same window, reset drifted
			{ rejected: true, limitType: 'five_hour', resetsAt },                         // refused
			{ rejected: false, limitType: 'five_hour', resetsAt: resetsAt + 5 * 3600 },   // next window
		]) {
			windows = applyClaudeLimit(windows, report);
			steps.push(windows[0].usedPercent);
		}
		assert.deepStrictEqual(steps, [undefined, 82, 82, 100, undefined]);
	});

	test('Claude Code windows keep a fixed order', () => {
		const windows = [
			{ rejected: false, limitType: 'seven_day_opus', utilization: 0.4 },
			{ rejected: false, limitType: 'five_hour', utilization: 0.1 },
			{ rejected: false, limitType: 'seven_day', utilization: 0.2 },
		].reduce<IUsageWindow[]>(applyClaudeLimit, []);
		assert.deepStrictEqual(windows.map(w => [w.id, w.label, w.usedPercent]), [
			['five_hour', 'Current session', 10],
			['seven_day', 'All models', 20],
			['seven_day_opus', 'Opus this week', 40],
		]);
	});

	test('the ring shows the live window closest to its limit', () => {
		const provider: IProviderLimits = {
			id: 'codex', label: 'Codex', glyph: 'CX', observedAt: at, source: '',
			windows: [
				{ id: 'old', label: 'old', usedPercent: 99, resetsAt: at - 1 },
				{ id: 'week', label: 'week', usedPercent: 40, resetsAt: at + 1000 },
				{ id: 'session', label: 'session', usedPercent: 73, resetsAt: at + 1000 },
				{ id: 'unknown', label: 'unknown', usedPercent: undefined, resetsAt: at + 1000 },
			],
		};
		assert.deepStrictEqual([headlineWindow(provider, at)?.id, headlineWindow({ ...provider, windows: [provider.windows[3]] }, at)?.id, headlineWindow({ ...provider, windows: [provider.windows[0]] }, at)?.id], ['session', 'unknown', undefined]);
	});

	test('severity follows the ring colors', () => {
		assert.deepStrictEqual([undefined, 0, 21, 52, 73, 90, 100].map(severityOf), ['unknown', 'ok', 'ok', 'elevated', 'high', 'critical', 'critical']);
	});

	test('alerts once per threshold per window, and again after it resets', () => {
		const thresholds = [80, 100];
		const resetsAt = at + 3600_000;
		const readings: IUsageWindow[] = [
			{ id: 'w', label: 'w', usedPercent: 50, resetsAt },
			{ id: 'w', label: 'w', usedPercent: 81, resetsAt },
			{ id: 'w', label: 'w', usedPercent: 85, resetsAt: resetsAt + 60_000 }, // drift is the same window
			{ id: 'w', label: 'w', usedPercent: undefined, resetsAt },
			{ id: 'w', label: 'w', usedPercent: 100, resetsAt },
			{ id: 'w', label: 'w', usedPercent: 100, resetsAt },
			{ id: 'w', label: 'w', usedPercent: 90, resetsAt: resetsAt + 5 * 3600_000 }, // new window, straight past 80
			{ id: 'w', label: 'w', usedPercent: 10, resetsAt: undefined },
			{ id: 'w', label: 'w', usedPercent: 50, resetsAt: undefined, exhausted: true },
		];
		let mark: IAlertMark | undefined;
		const alerts: (number | undefined)[] = [];
		for (const window of readings) {
			const next = nextAlert(mark, window, thresholds);
			alerts.push(next.alert);
			mark = next.mark;
		}
		assert.deepStrictEqual(alerts, [undefined, 80, undefined, undefined, 100, undefined, 80, undefined, 100]);
	});

	test('keeps only usable alert thresholds', () => {
		assert.deepStrictEqual([toThresholds([100, 80, 80, 0, -5, 120, '90']), toThresholds('80'), toThresholds([])], [[80, 100], [], []]);
	});

	test('says when a limit resets', () => {
		assert.deepStrictEqual([
			formatResets(at - 1, at),
			formatResets(at + 51 * 60_000 - 5_000, at),
			formatResets(at + 3 * 3600_000, at),
			formatResets(at + 3 * 3600_000 + 5 * 60_000, at),
		], ['Reset', 'Resets in 51 min', 'Resets in 3 h', 'Resets in 3 h 5 min']);
	});
});
