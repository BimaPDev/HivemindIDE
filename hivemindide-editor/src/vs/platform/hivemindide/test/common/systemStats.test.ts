/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { cpuPercent, isSystemListener, parseLsofListening, parsePmsetBattery, parseVmStat } from '../../common/systemStats.js';

suite('HivemindIDE system stats', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('memory in use, counted like Activity Monitor', () => {
		const vmstat = [
			'Mach Virtual Memory Statistics: (page size of 16384 bytes)',
			'Pages free:                                6634.',
			'Pages active:                            260434.',
			'Pages inactive:                          259052.',
			'Pages wired down:                        223772.',
			'Pages stored in compressor:             1277009.',
			'Pages occupied by compressor:            257412.',
		].join('\n');
		assert.deepStrictEqual([parseVmStat(vmstat), parseVmStat('nothing useful')], [(260434 + 223772 + 257412) * 16384, undefined]);
	});

	test('battery: charging, on battery, full, and a Mac without one', () => {
		assert.deepStrictEqual([
			parsePmsetBattery(`Now drawing from 'Battery Power'\n -InternalBattery-0 (id=23199843)\t66%; discharging; 5:38 remaining present: true`),
			parsePmsetBattery(`Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t80%; charging; 1:02 remaining present: true`),
			parsePmsetBattery(`Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true`),
			parsePmsetBattery(`Now drawing from 'AC Power'`),
		], [
			{ percent: 66, charging: false, onPower: false, remaining: '5:38' },
			{ percent: 80, charging: true, onPower: true, remaining: '1:02' },
			{ percent: 100, charging: false, onPower: true, remaining: undefined },
			undefined,
		]);
	});

	test('listening ports: one per process and port, by port', () => {
		const lsof = ['p679', 'crapportd', 'f10', 'n*:64005', 'f11', 'n*:64005', 'p4242', 'cnode', 'f22', 'n127.0.0.1:5173', 'f23', 'n[::1]:5173', 'p900', 'cpostgres', 'f5', 'n*:5432'].join('\n');
		const ports = parseLsofListening(lsof);
		assert.deepStrictEqual(ports, [
			{ pid: 4242, command: 'node', port: 5173, address: '127.0.0.1' },
			{ pid: 900, command: 'postgres', port: 5432, address: '*' },
			{ pid: 679, command: 'rapportd', port: 64005, address: '*' },
		]);
		assert.deepStrictEqual(ports.map(p => isSystemListener(p.command)), [false, false, true]);
	});

	test('CPU busy between two snapshots', () => {
		const before = [{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }, { times: { user: 0, nice: 0, sys: 0, idle: 1000, irq: 0 } }];
		const after = [{ times: { user: 200, nice: 0, sys: 100, idle: 900, irq: 0 } }, { times: { user: 50, nice: 0, sys: 0, idle: 1150, irq: 0 } }];
		// Core 1: 150 busy of 200; core 2: 50 busy of 200 → 200 of 400.
		assert.deepStrictEqual([cpuPercent(before, after), cpuPercent(before, before)], [50, undefined]);
	});
});
