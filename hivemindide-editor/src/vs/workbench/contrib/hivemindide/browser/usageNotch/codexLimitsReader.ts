/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Reads Codex's plan limits from its own session logs.
 *
 *  Every Codex turn appends a `token_count` event to
 *  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl carrying the rate-limit snapshot
 *  the server sent back: percent used and reset time for the 5-hour and weekly
 *  windows. The newest snapshot is the newest such line in the most recently
 *  written log. Read-only; only the log's tail is read, and an unchanged file
 *  is not read again.
 *--------------------------------------------------------------------------------------------*/

import { ResourceMap } from '../../../../../base/common/map.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { IFileService, IFileStatWithMetadata } from '../../../../../platform/files/common/files.js';
import { IPathService } from '../../../../services/path/common/pathService.js';
import { IProviderLimits, parseCodexRateLimits } from '../../common/usageLimits.js';

/** Logs are one JSON object per line; a snapshot is always among the last few hundred KB. */
const TAIL_BYTES = 256 * 1024;
/** A session that runs past midnight keeps writing into the day it started. */
const CANDIDATE_DAYS = 3;
const CANDIDATE_FILES = 8;

type Snapshot = ReturnType<typeof parseCodexRateLimits>;

export class CodexLimitsReader {

	private readonly cache = new ResourceMap<{ readonly mtime: number; readonly snapshot: Snapshot }>();

	constructor(
		private readonly fileService: IFileService,
		private readonly pathService: IPathService,
	) { }

	async read(): Promise<IProviderLimits | undefined> {
		const root = URI.joinPath(this.pathService.userHome({ preferLocal: true }), '.codex', 'sessions');
		let files: IFileStatWithMetadata[];
		try {
			files = await this.newestLogs(root);
		} catch {
			// Codex is not installed, or has never run. Not worth logging on a timer.
			return undefined;
		}

		for (const key of [...this.cache.keys()]) {
			if (!files.some(f => f.resource.toString() === key.toString())) {
				this.cache.delete(key);
			}
		}

		for (const file of files) {
			const snapshot = await this.snapshotOf(file);
			if (snapshot) {
				return {
					id: 'codex',
					label: 'Codex',
					glyph: 'CX',
					windows: snapshot.windows,
					observedAt: snapshot.observedAt,
					source: localize('usageNotch.codex.source', "Codex session log on this machine"),
				};
			}
		}
		return undefined;
	}

	private async newestLogs(root: URI): Promise<IFileStatWithMetadata[]> {
		const days: URI[] = [];
		await this.collectNewestDays(root, 3, days);
		const files: IFileStatWithMetadata[] = [];
		for (const day of days) {
			const stat = await this.fileService.resolve(day, { resolveMetadata: true });
			files.push(...(stat.children ?? []).filter(c => c.isFile && /^rollout-.*\.jsonl$/.test(c.name)));
		}
		return files.sort((a, b) => b.mtime - a.mtime).slice(0, CANDIDATE_FILES);
	}

	/** The newest `YYYY/MM/DD` folders, newest first. Names are zero-padded, so they sort as text. */
	private async collectNewestDays(dir: URI, depth: number, out: URI[]): Promise<void> {
		const stat = await this.fileService.resolve(dir);
		const children = (stat.children ?? [])
			.filter(c => c.isDirectory && /^\d+$/.test(c.name))
			.sort((a, b) => b.name.localeCompare(a.name));
		for (const child of children) {
			if (out.length >= CANDIDATE_DAYS) {
				return;
			}
			if (depth === 1) {
				out.push(child.resource);
			} else {
				await this.collectNewestDays(child.resource, depth - 1, out);
			}
		}
	}

	private async snapshotOf(file: IFileStatWithMetadata): Promise<Snapshot> {
		const cached = this.cache.get(file.resource);
		if (cached && cached.mtime === file.mtime) {
			return cached.snapshot;
		}

		let snapshot: Snapshot;
		try {
			const position = Math.max(0, file.size - TAIL_BYTES);
			const content = await this.fileService.readFile(file.resource, { position });
			const lines = content.value.toString().split('\n');
			// Reading from the middle cuts the first line; it cannot parse, so skip it.
			for (let i = lines.length - 1; i >= (position > 0 ? 1 : 0) && !snapshot; i--) {
				snapshot = parseCodexRateLimits(lines[i]);
			}
		} catch {
			snapshot = undefined;
		}
		this.cache.set(file.resource, { mtime: file.mtime, snapshot });
		return snapshot;
	}
}
