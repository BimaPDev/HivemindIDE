/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Every assistant's plan limits, from wherever this machine already knows them:
 *
 *  - Claude Code: the `rate_limit_event`s it prints while running a turn inside
 *    HivemindIDE. Kept in application storage, so a new window or a restart
 *    still knows them until the window resets.
 *  - Codex: its session logs (see CodexLimitsReader), whether it ran here or
 *    in a terminal.
 *  - Backup providers: the ones failover took out of rotation for quota or
 *    rate limits, until they are tried again.
 *
 *  Lives only while the notch is enabled; disposing it stops every timer and
 *  listener.
 *--------------------------------------------------------------------------------------------*/

import { IntervalTimer } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { HivemindShellEvent, IHivemindShellService } from '../../../../../platform/hivemindide/common/hivemindShell.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { ProviderFailureKind } from '../../common/providerFailover.js';
import { applyClaudeLimit, IProviderLimits, IUsageWindow, liveWindows } from '../../common/usageLimits.js';
import { IProviderFailoverService } from '../localModels/providerFailoverService.js';
import { CodexLimitsReader } from './codexLimitsReader.js';

const CLAUDE_STORAGE_KEY = 'hivemindide.usageNotch.claude';
const POLL_MS = 60_000;

interface IStoredClaude {
	readonly windows: IUsageWindow[];
	readonly observedAt: number;
}

export class UsageLimitsModel extends Disposable {

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	private readonly timer = this._register(new IntervalTimer());
	private readonly codexReader: CodexLimitsReader;
	private codex: IProviderLimits | undefined;
	private claude: IStoredClaude | undefined;
	private reading: Promise<void> | undefined;

	constructor(
		@IFileService fileService: IFileService,
		@IPathService pathService: IPathService,
		@IStorageService private readonly storageService: IStorageService,
		@IHivemindShellService shellService: IHivemindShellService,
		@IProviderFailoverService private readonly failoverService: IProviderFailoverService,
	) {
		super();
		this.codexReader = new CodexLimitsReader(fileService, pathService);
		this.claude = this.loadClaude();

		this._register(shellService.onDidEvent(e => this.onShellEvent(e)));
		// Another window heard a Claude Code run.
		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, CLAUDE_STORAGE_KEY, this._store)(e => {
			if (e.external) {
				this.claude = this.loadClaude();
				this._onDidChange.fire();
			}
		}));
		this._register(this.failoverService.onDidChange(() => this._onDidChange.fire()));

		// Also re-renders on the minute, so windows that reset drop out.
		this.timer.cancelAndSet(() => this.refresh(), POLL_MS);
		this.refresh();
	}

	/**
	 * Claude Code first, then Codex, then backups that ran out, as the notch
	 * stacks them. Claude Code and Codex always have a ring, with no windows
	 * until their first reading, so the notch is there from the start.
	 */
	get providers(): IProviderLimits[] {
		const now = Date.now();
		const providers: IProviderLimits[] = [
			{
				id: 'claude',
				label: 'Claude Code',
				glyph: 'CC',
				windows: this.claude?.windows ?? [],
				observedAt: this.claude?.observedAt,
				source: this.claude
					? localize('usageNotch.claude.source', "Reported by Claude Code while it ran in HivemindIDE")
					: localize('usageNotch.claude.noReading', "No reading yet. Claude Code reports its limits while it runs a turn in HivemindIDE; the ring fills in from the first one."),
			},
			this.codex ?? {
				id: 'codex',
				label: 'Codex',
				glyph: 'CX',
				windows: [],
				source: localize('usageNotch.codex.noReading', "No reading yet. Codex writes its limits to its session log after each turn, in HivemindIDE or a terminal; the ring fills in from the next one."),
			},
		];
		for (const backup of this.backups()) {
			const same = providers.findIndex(p => p.label.toLowerCase() === backup.label.toLowerCase());
			if (same >= 0) {
				providers[same] = { ...providers[same], windows: [...providers[same].windows, ...backup.windows] };
			} else {
				providers.push(backup);
			}
		}
		// A backup is only interesting while it is out; Claude and Codex keep their ring.
		return providers.filter(p => !p.id.startsWith('backup:') || liveWindows(p, now).length > 0);
	}

	refresh(): Promise<void> {
		this.reading ??= (async () => {
			try {
				this.codex = await this.codexReader.read();
			} finally {
				this.reading = undefined;
			}
			this._onDidChange.fire();
		})();
		return this.reading;
	}

	private onShellEvent(e: HivemindShellEvent): void {
		if (e.kind !== 'limit' || e.agent !== 'claude') {
			return;
		}
		this.claude = { windows: applyClaudeLimit(this.claude?.windows ?? [], e), observedAt: Date.now() };
		this.storageService.store(CLAUDE_STORAGE_KEY, JSON.stringify(this.claude), StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._onDidChange.fire();
	}

	private loadClaude(): IStoredClaude | undefined {
		const raw = this.storageService.get(CLAUDE_STORAGE_KEY, StorageScope.APPLICATION);
		if (!raw) {
			return undefined;
		}
		try {
			const stored = JSON.parse(raw) as IStoredClaude;
			return Array.isArray(stored.windows) && typeof stored.observedAt === 'number' ? stored : undefined;
		} catch {
			return undefined;
		}
	}

	private backups(): IProviderLimits[] {
		return this.failoverService.activeCooldowns()
			.filter(([, c]) => c.failure.kind === ProviderFailureKind.Quota || c.failure.kind === ProviderFailureKind.RateLimit)
			.map(([name, c]): IProviderLimits => ({
				id: `backup:${name}`,
				label: name,
				glyph: initials(name),
				windows: [{
					id: 'failover',
					label: c.failure.kind === ProviderFailureKind.Quota
						? localize('usageNotch.backup.quota', "Out of quota")
						: localize('usageNotch.backup.rateLimit', "Rate limited"),
					usedPercent: 100,
					resetsAt: c.until,
					exhausted: true,
				}],
				observedAt: Date.now(),
				source: localize('usageNotch.backup.source', "Refused a request; failover skips it until then"),
			}));
	}
}

/** "OpenRouter" -> "OR", "groq" -> "GR". */
function initials(name: string): string {
	const words = name.split(/[\s\-_.]+/).filter(Boolean);
	const letters = words.length > 1 ? words[0][0] + words[1][0] : name.replace(/[^a-z0-9]/gi, '').slice(0, 2);
	return letters.toUpperCase() || '?';
}
