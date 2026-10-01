#!/usr/bin/env node
// Launch HivemindIDE from source on macOS, Linux and Windows.
//
//   ./fork/run.sh              macOS and Linux
//   fork\run.cmd               Windows
//   node fork/run.mjs          any of the three
//
// Strips the host editor's ELECTRON_RUN_AS_NODE and VSCODE_* variables (a
// terminal inside VS Code or Cursor otherwise boots this fork as plain Node),
// and the same for a Claude Code session's variables. Selects the Node version
// in hivemindide-editor/.nvmrc, then runs scripts/code.sh or scripts/code.bat.
//
//   node fork/run.mjs --dry-run    print the launch and exit

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureOut } from './ensure-out.mjs';
import {
	editorCommand,
	editorDir,
	findNodeBinary,
	prependPath,
	readPinnedNodeVersion,
	resolveAccountHome,
	scrubEnv,
	versionsMatch,
	withAccountHome,
} from './launch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dryRun = args[0] === '--dry-run';
const editorArgs = dryRun ? args.slice(1) : args;

const editor = editorDir(here, process.env);
if (!existsSync(editor)) {
	console.error(`no checkout at ${editor}`);
	process.exit(1);
}

let pinned = '';
try {
	pinned = readPinnedNodeVersion(editor);
} catch {
	console.error(`warning: no .nvmrc in ${editor}; using ${process.version}`);
}

const accountHome = resolveAccountHome(process.platform, process.env);
if (pinned && process.env.HIVEMINDIDE_NODE_PINNED !== '1') {
	const found = findNodeBinary(pinned, process.env, process.platform, accountHome);
	if (found && !versionsMatch(process.version, pinned)) {
		const env = { ...process.env, HIVEMINDIDE_NODE_PINNED: '1' };
		prependPath(env, path.dirname(found), process.platform);
		const code = await runChild(found, [fileURLToPath(import.meta.url), ...args], env);
		process.exit(code);
	}
	if (!versionsMatch(process.version, pinned)) {
		console.error(`warning: node ${pinned} not found under nvm, fnm, volta or asdf; using ${process.version}`);
	}
}

const homed = withAccountHome(process.env, process.platform, accountHome);
for (const note of homed.notes) {
	console.error(note);
}
const env = scrubEnv(homed.env);
prependPath(env, path.dirname(process.execPath), process.platform);

const command = editorCommand(editor, process.platform, editorArgs);
if (dryRun) {
	console.log(JSON.stringify({
		editor,
		node: process.execPath,
		nodeVersion: process.version,
		pinned: pinned || null,
		platform: process.platform,
		command: command.command,
		args: command.args,
		cwd: command.cwd,
	}, null, 2));
	process.exit(0);
}

try {
	await ensureOut(editor, process.execPath);
} catch (err) {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
}

const code = await runChild(command.command, command.args, env, command.cwd, command.shell);
process.exit(code);

function runChild(command, args, env, cwd = process.cwd(), shell = false) {
	return new Promise(resolve => {
		const child = spawn(command, args, { cwd, env, stdio: 'inherit', windowsHide: false, shell });
		child.on('error', err => {
			console.error(err.message);
			resolve(1);
		});
		child.on('exit', (code, signal) => {
			resolve(code ?? (signal ? 1 : 0));
		});
	});
}
