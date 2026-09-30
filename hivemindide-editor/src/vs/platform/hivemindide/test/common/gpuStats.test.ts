/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { formatBytes, parseIoregGpu, parseNvidiaSmi, parseOllamaPs } from '../../common/gpuStats.js';

suite('HivemindIDE GPU stats', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('Apple silicon: the driver counters from ioreg', () => {
		// Trimmed from `ioreg -r -d 1 -w 0 -c IOAccelerator` on an M3 MacBook Air.
		const ioreg = `+-o AGXAcceleratorG15G  <class AGXAcceleratorG15G, id 0x1000003bd>
    {
      "IOClass" = "AGXAcceleratorG15G"
      "model" = "Apple M3"
      "gpu-core-count" = 10
      "PerformanceStatistics" = {"In use system memory (driver)"=0,"Alloc system memory"=6093651968,"Tiler Utilization %"=32,"Renderer Utilization %"=31,"Device Utilization %"=34,"In use system memory"=3898310656}
    }`;
		assert.deepStrictEqual(parseIoregGpu(ioreg, 17179869184), { name: 'Apple M3', backend: 'Metal', utilization: 34, memoryUsed: 3898310656, memoryTotal: 17179869184, cores: 10 });
		assert.strictEqual(parseIoregGpu('no accelerator here'), undefined);
	});

	test('NVIDIA: nvidia-smi csv, memory in MiB', () => {
		assert.deepStrictEqual(parseNvidiaSmi('NVIDIA GeForce RTX 4090, 87, 6144, 24564, 63\nNVIDIA GeForce RTX 3060, 0, 10, 12288, 40\n'), {
			name: 'NVIDIA GeForce RTX 4090', backend: 'CUDA', utilization: 87, memoryUsed: 6144 * 1048576, memoryTotal: 24564 * 1048576, temperatureC: 63,
		});
		// Fields a driver cannot report come back as "[N/A]".
		assert.deepStrictEqual(parseNvidiaSmi('Tesla T4, [N/A], 100, 15360, [N/A]'), { name: 'Tesla T4', backend: 'CUDA', utilization: undefined, memoryUsed: 100 * 1048576, memoryTotal: 15360 * 1048576, temperatureC: undefined });
		assert.strictEqual(parseNvidiaSmi(''), undefined);
	});

	test('Ollama: how much of each model is in GPU memory', () => {
		const ps = JSON.stringify({ models: [
			{ name: 'gemma:2b', size: 1861159484, size_vram: 1861159484, context_length: 4096 },
			{ name: 'llama3:70b', size: 40_000_000_000, size_vram: 10_000_000_000 },
			{ name: 'broken' },
		] });
		assert.deepStrictEqual(parseOllamaPs(ps), [
			{ model: 'gemma:2b', bytes: 1861159484, gpuPercent: 100, contextLength: 4096 },
			{ model: 'llama3:70b', bytes: 40_000_000_000, gpuPercent: 25, contextLength: undefined },
		]);
		assert.deepStrictEqual([parseOllamaPs('not json'), parseOllamaPs('{}')], [[], []]);
	});

	test('sizes read like the rest of macOS', () => {
		assert.deepStrictEqual([formatBytes(3898310656), formatBytes(512_000_000)], ['3.9 GB', '512 MB']);
	});
});
