/*---------------------------------------------------------------------------------------------
 *  HivemindIDE hivemind: reading and writing node files.
 *
 *  Pure string functions, so they can be tested from node without a
 *  workbench. The format is the one hivemindProtocol.ts documents for other
 *  AI tools; parsing is lenient because those tools write these files by
 *  hand, and anything not understood (extra front-matter keys, extra
 *  sections) is kept on rewrite.
 *--------------------------------------------------------------------------------------------*/

import { HivemindNodeStatus } from './hivemindProtocol.js';

export interface IHivemindNodeHeader {
	readonly id: string;
	readonly title: string;
	readonly parent?: string;
	readonly status: HivemindNodeStatus;
	readonly author: string;
	readonly agent: string;
	readonly model?: string;
	readonly created: string;
	readonly updated: string;
}

export interface IHivemindNodeDocument {
	header: IHivemindNodeHeader;
	/** Front-matter keys this parser does not know, preserved verbatim. */
	extraHeader: [string, string][];
	/** `## Heading` → body, in file order. */
	sections: [string, string][];
}

const KNOWN_KEYS = ['id', 'title', 'parent', 'status', 'author', 'agent', 'model', 'created', 'updated'];
const SECTION_ORDER = ['Goal', 'Handoff', 'Files', 'Log'];

export function parseHivemindNode(text: string): IHivemindNodeDocument | undefined {
	const normalized = text.replace(/\r\n/g, '\n');
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
	if (!match) {
		return undefined;
	}

	const values = new Map<string, string>();
	const extraHeader: [string, string][] = [];
	for (const line of match[1].split('\n')) {
		const colon = line.indexOf(':');
		if (colon <= 0) {
			continue;
		}
		const key = line.slice(0, colon).trim();
		const value = unquote(line.slice(colon + 1).trim());
		if (KNOWN_KEYS.includes(key)) {
			values.set(key, value);
		} else {
			extraHeader.push([key, value]);
		}
	}

	const id = values.get('id');
	if (!id) {
		return undefined;
	}
	const status = values.get('status');
	const header: IHivemindNodeHeader = {
		id,
		title: values.get('title') || id,
		parent: values.get('parent') || undefined,
		status: status === 'done' || status === 'paused' ? status : 'active',
		author: values.get('author') || 'unknown',
		agent: values.get('agent') || 'unknown',
		model: values.get('model') || undefined,
		created: values.get('created') || '',
		updated: values.get('updated') || values.get('created') || '',
	};

	const sections: [string, string][] = [];
	const parts = match[2].split(/^## +(.+?)\s*$/m);
	// parts: [preamble, heading1, body1, heading2, body2, ...]
	for (let i = 1; i < parts.length; i += 2) {
		sections.push([parts[i], (parts[i + 1] ?? '').trim()]);
	}
	return { header, extraHeader, sections };
}

export function serializeHivemindNode(doc: IHivemindNodeDocument): string {
	const h = doc.header;
	const lines = ['---'];
	const put = (key: string, value: string | undefined) => {
		if (value) {
			lines.push(`${key}: ${oneLine(value)}`);
		}
	};
	put('id', h.id);
	put('title', h.title);
	put('parent', h.parent);
	put('status', h.status);
	put('author', h.author);
	put('agent', h.agent);
	put('model', h.model);
	put('created', h.created);
	put('updated', h.updated);
	for (const [key, value] of doc.extraHeader) {
		put(key, value);
	}
	lines.push('---', '');

	const ordered = [
		...SECTION_ORDER.map(name => doc.sections.find(([heading]) => heading === name)).filter((s): s is [string, string] => !!s),
		...doc.sections.filter(([heading]) => !SECTION_ORDER.includes(heading)),
	];
	for (const [heading, body] of ordered) {
		lines.push(`## ${heading}`, body.trim(), '');
	}
	return lines.join('\n');
}

export function getSection(doc: IHivemindNodeDocument, heading: string): string {
	return doc.sections.find(([h]) => h === heading)?.[1] ?? '';
}

export function setSection(doc: IHivemindNodeDocument, heading: string, body: string): void {
	const existing = doc.sections.find(([h]) => h === heading);
	if (existing) {
		existing[1] = body;
	} else {
		doc.sections.push([heading, body]);
	}
}

/** `YYYYMMDD-HHMM-short-slug-xxxx`, UTC, as the protocol specifies. */
export function newHivemindNodeId(title: string, now = new Date(), random = Math.random): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	const stamp = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`;
	const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 4).join('-') || 'work';
	const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
	let suffix = '';
	for (let i = 0; i < 4; i++) {
		suffix += alphabet[Math.floor(random() * alphabet.length)];
	}
	return `${stamp}-${slug}-${suffix}`;
}

/** File paths listed in a Files section (`- path` lines). */
export function parseFileList(body: string): string[] {
	return body.split('\n')
		.map(line => /^\s*[-*]\s+`?([^`]+?)`?\s*$/.exec(line)?.[1])
		.filter((p): p is string => !!p);
}

function oneLine(value: string): string {
	return value.replace(/\s*\n\s*/g, ' ').trim();
}

function unquote(value: string): string {
	return /^(['"]).*\1$/.test(value) ? value.slice(1, -1) : value;
}
