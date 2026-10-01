/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The Mac tab of the MacBook notch: how the machine is holding up while
 *  agents and local models work, and what is listening on its ports.
 *  Read with the tools macOS ships, no elevated rights: `vm_stat` for memory,
 *  `pmset -g batt` for the battery, `lsof` for listening sockets. Pure parsers
 *  here; running the tools is the main process's job.
 *--------------------------------------------------------------------------------------------*/

export interface ISystemStats {
	/** Percent of all cores busy since the previous reading. */
	readonly cpu?: number;
	readonly memoryUsed?: number;
	readonly memoryTotal?: number;
	readonly battery?: IBatteryState;
	/** macOS thermal pressure: `nominal`, `fair`, `serious`, `critical` (or `unknown`). */
	readonly thermal?: string;
}

export interface IBatteryState {
	readonly percent: number;
	readonly charging: boolean;
	/** On the charger, whether charging or full. */
	readonly onPower: boolean;
	/** "5:38" left, when macOS has an estimate. */
	readonly remaining?: string;
}

export interface IListeningPort {
	readonly pid: number;
	readonly command: string;
	readonly port: number;
	/** `*` for every interface, else the address it is bound to. */
	readonly address: string;
}

/**
 * `vm_stat` → bytes in use the way Activity Monitor counts "Memory Used":
 * active + wired + what the compressor holds.
 */
export function parseVmStat(output: string): number | undefined {
	const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
	const pages = (label: string) => {
		const match = new RegExp(`^${label}:\\s+(\\d+)\\.`, 'm').exec(output);
		return match ? Number(match[1]) : undefined;
	};
	const active = pages('Pages active'), wired = pages('Pages wired down'), compressed = pages('Pages occupied by compressor');
	if (!pageSize || active === undefined || wired === undefined) {
		return undefined;
	}
	return (active + wired + (compressed ?? 0)) * pageSize;
}

/** `pmset -g batt` → the internal battery, or undefined on a Mac without one. */
export function parsePmsetBattery(output: string): IBatteryState | undefined {
	const line = output.split('\n').find(l => /InternalBattery/.test(l));
	const percent = line ? /(\d+)%/.exec(line)?.[1] : undefined;
	if (!line || percent === undefined) {
		return undefined;
	}
	const state = /\d+%;\s*([^;]+);/.exec(line)?.[1]?.trim() ?? '';
	const remaining = /(\d+:\d{2}) remaining/.exec(line)?.[1];
	return {
		percent: Number(percent),
		charging: state === 'charging',
		onPower: /AC Power/.test(output) || state === 'charging' || state === 'charged' || state === 'finishing charge',
		remaining: remaining && remaining !== '0:00' ? remaining : undefined,
	};
}

/**
 * `lsof -nP -iTCP -sTCP:LISTEN -Fpcn` → one entry per process and port
 * (IPv4 and IPv6 sockets on the same port count once), by port.
 */
export function parseLsofListening(output: string): IListeningPort[] {
	const found = new Map<string, IListeningPort>();
	let pid = 0, command = '';
	for (const line of output.split('\n')) {
		const field = line[0], value = line.slice(1);
		if (field === 'p') {
			pid = Number(value);
		} else if (field === 'c') {
			command = value;
		} else if (field === 'n' && pid) {
			const match = /^(.*):(\d+)$/.exec(value);
			if (match) {
				const port = Number(match[2]);
				const key = `${pid}:${port}`;
				if (!found.has(key)) {
					found.set(key, { pid, command, port, address: match[1].replace(/^\[|\]$/g, '') });
				}
			}
		}
	}
	return [...found.values()].sort((a, b) => a.port - b.port || a.pid - b.pid);
}

/** macOS's own listeners (AirPlay receiver, Handoff…): not what a developer means by "my ports". */
const SYSTEM_LISTENERS = /^(ControlCenter|rapportd|sharingd|remoted|identityservicesd|launchd|mDNSResponder|AirPlayXPCHelper|UserEventAgent|WiFiAgent|screensharingd|ARDAgent|kdc|cupsd)$/;

export function isSystemListener(command: string): boolean {
	return SYSTEM_LISTENERS.test(command);
}

/** CPU busy percent between two `os.cpus()` snapshots. */
export function cpuPercent(previous: readonly { readonly times: Readonly<Record<string, number>> }[], current: readonly { readonly times: Readonly<Record<string, number>> }[]): number | undefined {
	let busy = 0, total = 0;
	for (let i = 0; i < Math.min(previous.length, current.length); i++) {
		const a = previous[i].times, b = current[i].times;
		const sum = (t: Readonly<Record<string, number>>) => Object.values(t).reduce((s, v) => s + v, 0);
		const all = sum(b) - sum(a);
		total += all;
		busy += all - ((b.idle ?? 0) - (a.idle ?? 0));
	}
	return total > 0 ? Math.min(100, Math.max(0, busy / total * 100)) : undefined;
}
