/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  What the GPU is doing while a local model runs: how busy it is and how much
 *  memory is taken. Read without elevated rights:
 *  - Apple silicon (Metal): `ioreg -c IOAccelerator`, the driver's own counters;
 *  - NVIDIA (CUDA): `nvidia-smi --query-gpu`;
 *  - and, for Ollama, `/api/ps`: how much of the loaded model sits in GPU memory.
 *  Pure parsers here; running the commands is the main process's job.
 *--------------------------------------------------------------------------------------------*/

export interface IGpuStats {
	/** "Apple M3", "NVIDIA GeForce RTX 4090". */
	readonly name: string;
	readonly backend: 'Metal' | 'CUDA';
	/** Percent of the GPU busy, 0–100. */
	readonly utilization?: number;
	/** Bytes of GPU memory in use, and in all (on Apple silicon, the unified memory). */
	readonly memoryUsed?: number;
	readonly memoryTotal?: number;
	readonly temperatureC?: number;
	readonly cores?: number;
}

/** How much of one loaded model the runtime put in GPU memory. */
export interface IModelOffload {
	readonly model: string;
	/** 0–100: 100 is "100% GPU" in `ollama ps`. */
	readonly gpuPercent: number;
	readonly bytes: number;
	readonly contextLength?: number;
}

export const NVIDIA_SMI_ARGS = ['--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu', '--format=csv,noheader,nounits'];

/** `ioreg -r -d 1 -w 0 -c IOAccelerator` → the first GPU's name, cores, utilization and memory in use. */
export function parseIoregGpu(output: string, unifiedMemory?: number): IGpuStats | undefined {
	const name = /"model"\s*=\s*"([^"]+)"/.exec(output)?.[1];
	const stats = /"PerformanceStatistics"\s*=\s*\{([^}]*)\}/.exec(output)?.[1];
	if (!name || !stats) {
		return undefined;
	}
	const number = (key: string) => {
		const match = new RegExp(`"${key.replace(/[.*+?^${}()|[\]\\%]/g, '\\$&')}"\\s*=\\s*(\\d+)`).exec(stats);
		return match ? Number(match[1]) : undefined;
	};
	const cores = /"gpu-core-count"\s*=\s*(\d+)/.exec(output)?.[1];
	return {
		name,
		backend: 'Metal',
		utilization: clampPercent(number('Device Utilization %')),
		memoryUsed: number('In use system memory'),
		memoryTotal: unifiedMemory,
		cores: cores ? Number(cores) : undefined,
	};
}

/** `nvidia-smi` with NVIDIA_SMI_ARGS → the first GPU. Memory is reported in MiB. */
export function parseNvidiaSmi(output: string): IGpuStats | undefined {
	const line = output.split('\n').map(l => l.trim()).find(Boolean);
	const fields = line?.split(',').map(f => f.trim());
	if (!fields || fields.length < 4 || !fields[0]) {
		return undefined;
	}
	const n = (s: string | undefined) => s !== undefined && /^\d+(\.\d+)?$/.test(s) ? Number(s) : undefined;
	const mib = (s: string | undefined) => { const v = n(s); return v === undefined ? undefined : v * 1024 * 1024; };
	return {
		name: fields[0],
		backend: 'CUDA',
		utilization: clampPercent(n(fields[1])),
		memoryUsed: mib(fields[2]),
		memoryTotal: mib(fields[3]),
		temperatureC: n(fields[4]),
	};
}

/** Ollama's `/api/ps` → how much of each loaded model is in GPU memory. */
export function parseOllamaPs(output: string): IModelOffload[] {
	try {
		const models = JSON.parse(output)?.models;
		return Array.isArray(models) ? models.flatMap((m: { name?: unknown; size?: unknown; size_vram?: unknown; context_length?: unknown }) =>
			typeof m?.name === 'string' && typeof m.size === 'number' && m.size > 0 && typeof m.size_vram === 'number'
				? [{ model: m.name, bytes: m.size, gpuPercent: clampPercent(m.size_vram / m.size * 100)!, contextLength: typeof m.context_length === 'number' ? m.context_length : undefined }]
				: []) : [];
	} catch {
		return [];
	}
}

/** A prompt Ollama cut to fit the model's loaded context. */
export interface IOllamaTruncation {
	readonly at: number;
	/** Tokens the prompt had. */
	readonly sent: number;
	/** Tokens Ollama kept: the start of the prompt is lost. */
	readonly kept: number;
}

/**
 * Ollama's server log → the prompts it cut since `sinceMs`. Ollama says so only
 * in its log (`msg="truncating input prompt" limit=2050 prompt=6793 keep=4 new=2050`);
 * the API answers as if nothing happened.
 */
export function parseOllamaTruncations(log: string, sinceMs: number): IOllamaTruncation[] {
	const found: IOllamaTruncation[] = [];
	for (const line of log.split('\n')) {
		if (!line.includes('truncating input prompt')) {
			continue;
		}
		const at = Date.parse(/\btime=(\S+)/.exec(line)?.[1] ?? '');
		const sent = /\bprompt=(\d+)/.exec(line)?.[1];
		const kept = /\bnew=(\d+)/.exec(line)?.[1];
		if (!isNaN(at) && at >= sinceMs && sent && kept) {
			found.push({ at, sent: Number(sent), kept: Number(kept) });
		}
	}
	return found;
}

/** 3898310656 → "3.9 GB". */
export function formatBytes(bytes: number): string {
	return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;
}

function clampPercent(value: number | undefined): number | undefined {
	return value === undefined || isNaN(value) ? undefined : Math.min(100, Math.max(0, value));
}
