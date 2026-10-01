import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { flattenNestedOut } from './ensure-out.mjs';
import {
	candidateNodeBins,
	editorCommand,
	editorDir,
	findNodeBinary,
	normalizeVersion,
	scrubEnv,
	versionsMatch,
	withAccountHome,
} from './launch.mjs';

test('editorDir prefers HIVEMINDIDE_EDITOR_DIR', () => {
	const dir = editorDir('/repo/fork', { HIVEMINDIDE_EDITOR_DIR: '/custom/editor' });
	assert.equal(dir, path.resolve('/custom/editor'));
});

test('editorDir defaults to the nested checkout', () => {
	const dir = editorDir('/repo/fork', {});
	assert.equal(dir, path.resolve('/repo/hivemindide-editor'));
});

test('normalizeVersion strips a leading v and whitespace', () => {
	assert.equal(normalizeVersion(' v24.18.0\r\n'), '24.18.0');
	assert.equal(versionsMatch('v24.18.0', '24.18.0'), true);
	assert.equal(versionsMatch('v22.12.0', '24.18.0'), false);
});

test('candidateNodeBins covers nvm on macOS and Linux and nvm-windows', () => {
	const unix = candidateNodeBins('24.18.0', {}, 'linux', '/home/dev');
	assert.ok(unix.includes('/home/dev/.nvm/versions/node/v24.18.0/bin/node'));
	assert.ok(unix.includes('/home/dev/.local/share/fnm/node-versions/v24.18.0/installation/bin/node'));
	const mac = candidateNodeBins('24.18.0', {}, 'darwin', '/Users/dev');
	assert.ok(mac.includes('/Users/dev/Library/Application Support/fnm/node-versions/v24.18.0/installation/bin/node'));
	const win = candidateNodeBins('24.18.0', { NVM_HOME: 'C:\\nvm', APPDATA: 'C:\\Users\\dev\\AppData\\Roaming' }, 'win32', 'C:\\Users\\dev');
	assert.ok(win.includes(path.win32.join('C:\\nvm', 'v24.18.0', 'node.exe')));
	assert.ok(win.some(bin => bin.endsWith(path.win32.join('fnm', 'node-versions', 'v24.18.0', 'installation', 'node.exe'))));
});

test('findNodeBinary returns the first install whose version matches', () => {
	const home = '/home/dev';
	const hit = '/home/dev/.nvm/versions/node/v24.18.0/bin/node';
	const found = findNodeBinary('24.18.0', {}, 'linux', home, {
		exists: file => file === hit,
		version: file => file === hit ? 'v24.18.0' : 'v22.0.0',
		execPath: '/usr/bin/node',
	});
	assert.equal(found, hit);
});

test('findNodeBinary falls back to the running node when it is the pinned version', () => {
	const found = findNodeBinary('24.18.0', {}, 'linux', '/home/dev', {
		exists: () => false,
		version: file => file === '/usr/local/bin/node' ? 'v24.18.0' : '',
		execPath: '/usr/local/bin/node',
	});
	assert.equal(found, '/usr/local/bin/node');
});

test('scrubEnv removes host-editor and agent variables, case-insensitively', () => {
	const env = scrubEnv({
		PATH: '/usr/bin',
		ELECTRON_RUN_AS_NODE: '1',
		vscode_pid: '99',
		CLAUDECODE: '1',
		GIT_CONFIG_COUNT: '1',
		GIT_CONFIG_KEY_0: 'user.name',
		HOME: '/real',
	});
	assert.deepEqual(env, { PATH: '/usr/bin', HOME: '/real' });
});

test('withAccountHome restores a redirected HOME', () => {
	const { env, notes } = withAccountHome({ HOME: '/tmp/scratch', PATH: '/usr/bin' }, 'linux', '/home/dev');
	assert.equal(env.HOME, '/home/dev');
	assert.equal(env.PATH, '/usr/bin');
	assert.equal(notes.length, 1);
});

test('withAccountHome restores USERPROFILE on Windows', () => {
	const { env, notes } = withAccountHome(
		{ HOME: 'C:\\scratch', USERPROFILE: 'C:\\scratch' },
		'win32',
		'C:\\Users\\dev',
	);
	assert.equal(env.HOME, 'C:\\Users\\dev');
	assert.equal(env.USERPROFILE, 'C:\\Users\\dev');
	assert.equal(notes.length, 2);
});

test('withAccountHome leaves an already-correct home alone', () => {
	const { env, notes } = withAccountHome({ HOME: '/home/dev' }, 'darwin', '/home/dev');
	assert.equal(env.HOME, '/home/dev');
	assert.deepEqual(notes, []);
});

test('editorCommand uses code.sh on Linux and code.bat on Windows', () => {
	const linux = editorCommand('/src/hivemindide-editor', 'linux', ['--disable-gpu']);
	assert.equal(linux.command, 'bash');
	assert.deepEqual(linux.args, ['/src/hivemindide-editor/scripts/code.sh', '--disable-gpu']);
	const win = editorCommand('C:\\src\\hivemindide-editor', 'win32', ['--disable-gpu']);
	assert.equal(win.command, 'scripts\\code.bat');
	assert.deepEqual(win.args, ['--disable-gpu']);
	assert.equal(win.shell, true);
	assert.equal(win.cwd, 'C:\\src\\hivemindide-editor');
});

test('flattenNestedOut copies out/vs/vs into out/vs', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'hivemind-out-'));
	try {
		const nested = path.join(root, 'out', 'vs', 'vs', 'base');
		await mkdir(nested, { recursive: true });
		await writeFile(path.join(nested, 'marker.js'), 'ok');
		const logs = [];
		assert.equal(await flattenNestedOut(root, { log: message => logs.push(message) }), true);
		const { readFile } = await import('node:fs/promises');
		assert.equal(await readFile(path.join(root, 'out', 'vs', 'base', 'marker.js'), 'utf8'), 'ok');
		const { existsSync } = await import('node:fs');
		assert.equal(existsSync(path.join(root, 'out', 'vs', 'vs')), false);
		assert.equal(logs.length, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
