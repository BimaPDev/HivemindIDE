#!/usr/bin/env node
// Ensure hivemindide-editor/out is bootable, on macOS, Linux and Windows.
//
// Upstream preLaunch only checks that `out/` exists, not that it is complete.
// A failed compile leaves a half-empty tree and the launch then dies on the
// first missing module. Also flattens `out/vs/vs` when tsc nested it, and
// copies .css files (tsc emits JavaScript only).

import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SENTINEL = ['out', 'vs', 'base', 'parts', 'ipc', 'common', 'ipc.js'];
const NESTED = ['out', 'vs', 'vs'];

const ESBUILD_ENTRIES = [
	'src/vs/workbench/contrib/hivemindide/common/agentTree.ts',
	'src/vs/workbench/contrib/hivemindide/browser/agentTreeWidget.ts',
	'src/vs/workbench/contrib/hivemindide/browser/agentTreeViewPane.ts',
	'src/vs/workbench/contrib/hivemindide/browser/agentDetailWidget.ts',
	'src/vs/workbench/contrib/hivemindide/browser/agentTree.contribution.ts',
	'src/vs/workbench/contrib/hivemindide/browser/hivemindide.contribution.ts',
	'src/vs/workbench/services/hivemindide/common/coordinationClient.ts',
];

export async function ensureOut(editorDir, nodeBin = process.execPath, log = console) {
	await syncCss(editorDir, log);
	const sentinel = path.join(editorDir, ...SENTINEL);
	if (await exists(sentinel)) {
		return;
	}
	if (await flattenNestedOut(editorDir, log) && await exists(sentinel)) {
		return;
	}
	await rebuildOut(editorDir, nodeBin, log);
	if (!await exists(sentinel)) {
		throw new Error(`still missing ${sentinel} after rebuild`);
	}
	log.log('==> out/ ready');
}

/** Copy each child of out/vs/vs into out/vs, then remove the nested directory. */
export async function flattenNestedOut(editorDir, log = console) {
	const nested = path.join(editorDir, ...NESTED);
	if (!await exists(nested)) {
		return false;
	}
	log.log('==> flattening out/vs/vs → out/vs');
	const dest = path.join(editorDir, 'out', 'vs');
	for (const name of await readdir(nested)) {
		await cp(path.join(nested, name), path.join(dest, name), { recursive: true, force: true });
	}
	await rm(nested, { recursive: true, force: true });
	return true;
}

async function syncCss(editorDir, log) {
	const root = path.join(editorDir, 'src', 'vs');
	if (!await exists(root)) {
		return;
	}
	const files = await walk(root, name => name.endsWith('.css'));
	let copied = 0;
	for (const src of files) {
		const rel = path.relative(path.join(editorDir, 'src'), src);
		const dest = path.join(editorDir, 'out', rel);
		if (!await exists(dest) || (await stat(src)).mtimeMs > (await stat(dest)).mtimeMs) {
			await mkdir(path.dirname(dest), { recursive: true });
			await cp(src, dest);
			copied++;
		}
	}
	if (copied > 0) {
		log.log(`==> synced ${copied} css file(s) into out/`);
	}
}

async function rebuildOut(editorDir, nodeBin, log) {
	log.log('==> rebuilding out/ (this takes a minute)');
	const tsc = path.join(editorDir, 'node_modules', '@typescript', 'native', 'bin', 'tsc');
	if (!await exists(tsc)) {
		throw new Error(`missing ${tsc}. From ${editorDir}, run: npm install`);
	}
	await run(nodeBin, [
		tsc,
		'--project', 'src/tsconfig.json',
		'--pretty', 'false',
		'--sourceMap',
		'--inlineSources',
		'--noEmitOnError', 'false',
	], editorDir);
	await flattenNestedOut(editorDir, log);
	await syncCss(editorDir, log);

	const mediaSrc = path.join(editorDir, 'src', 'vs', 'workbench', 'contrib', 'hivemindide', 'browser', 'media');
	const mediaOut = path.join(editorDir, 'out', 'vs', 'workbench', 'contrib', 'hivemindide', 'browser', 'media');
	if (await exists(mediaSrc)) {
		await mkdir(mediaOut, { recursive: true });
		for (const name of await readdir(mediaSrc)) {
			if (name.endsWith('.css')) {
				await cp(path.join(mediaSrc, name), path.join(mediaOut, name));
			}
		}
	}
	const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
	await run(npx, [
		'--yes', 'esbuild',
		...ESBUILD_ENTRIES,
		'--outdir=out/vs/workbench',
		'--outbase=src/vs/workbench',
		'--format=esm',
		'--platform=neutral',
		'--target=es2022',
		'--sourcemap',
	], editorDir);
}

function run(command, args, cwd) {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: 'inherit', windowsHide: false });
		child.on('error', reject);
		child.on('exit', (code, signal) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`${command} exited ${code ?? signal}`));
			}
		});
	});
}

async function exists(file) {
	try {
		await stat(file);
		return true;
	} catch {
		return false;
	}
}

async function walk(dir, pred, out = []) {
	let entries;
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await walk(full, pred, out);
		} else if (pred(entry.name)) {
			out.push(full);
		}
	}
	return out;
}

const isMain = process.argv[1]
	&& import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
	const editor = process.argv[2];
	if (!editor) {
		console.error('usage: node fork/ensure-out.mjs <editor-dir>');
		process.exit(1);
	}
	ensureOut(editor).catch(err => {
		console.error(err.message || err);
		process.exit(1);
	});
}
