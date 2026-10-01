// Shared by fork/run.mjs. Picks the Node version pinned in the editor's
// .nvmrc, scrubs host-editor environment variables, and builds the
// platform command (scripts/code.sh on macOS and Linux, scripts/code.bat
// on Windows). Keep the install locations in sync with fork/node-bin.sh
// and fork/run.ps1.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import path from 'node:path';

/** Host-editor and agent-session variables that break a from-source launch. */
export const ENV_DROP = [
	'ELECTRON_RUN_AS_NODE',
	'VSCODE_PID',
	'VSCODE_IPC_HOOK',
	'VSCODE_CWD',
	'VSCODE_NLS_CONFIG',
	'VSCODE_CODE_CACHE_PATH',
	'VSCODE_ESM_ENTRYPOINT',
	'VSCODE_CRASH_REPORTER_PROCESS_TYPE',
	'VSCODE_HANDLES_UNCAUGHT_ERRORS',
	'VSCODE_PROCESS_TITLE',
	'VSCODE_L10N_BUNDLE_LOCATION',
	'NoDefaultCurrentDirectoryInExePath',
	'CLAUDECODE',
	'CLAUDE_PID',
	'CLAUDE_CODE_ENTRYPOINT',
	'CLAUDE_CODE_SESSION_ID',
	'CLAUDE_CODE_CHILD_SESSION',
	'CLAUDE_CODE_MESSAGING_SOCKET',
	'CLAUDE_CODE_MESSAGING_TOKEN',
	'GIT_CONFIG_COUNT',
	'GIT_CONFIG_PARAMETERS',
	'HIVEMINDIDE_NODE_PINNED',
];

const DROP = new Set(ENV_DROP.map(name => name.toLowerCase()));

export function editorDir(forkDir, env) {
	if (env.HIVEMINDIDE_EDITOR_DIR) {
		return path.resolve(env.HIVEMINDIDE_EDITOR_DIR);
	}
	return path.resolve(forkDir, '..', 'hivemindide-editor');
}

export function readPinnedNodeVersion(editorDirPath) {
	const raw = readFileSync(path.join(editorDirPath, '.nvmrc'), 'utf8');
	return normalizeVersion(raw);
}

export function normalizeVersion(version) {
	return String(version).trim().replace(/^v/i, '');
}

export function versionsMatch(actual, wanted) {
	return normalizeVersion(actual) === normalizeVersion(wanted);
}

/**
 * The account's real home. `os.homedir()` follows HOME, which an agent shell
 * may have pointed at a scratch folder; the password database does not.
 */
export function resolveAccountHome(platform, env) {
	try {
		const home = userInfo().homedir;
		if (home) {
			return home;
		}
	} catch {
		// No passwd entry (some containers). Fall through to the environment.
	}
	if (platform === 'win32') {
		return env.USERPROFILE || env.HOME || '';
	}
	return env.HOME || '';
}

function pathApi(platform) {
	return platform === 'win32' ? path.win32 : path.posix;
}

function samePath(platform, a, b) {
	if (!a || !b) {
		return false;
	}
	const p = pathApi(platform);
	return p.resolve(a) === p.resolve(b);
}

/**
 * Point HOME (and USERPROFILE on Windows) at the account home when a parent
 * process redirected them. Returns a copy plus notes to print.
 */
export function withAccountHome(env, platform, accountHome) {
	const next = { ...env };
	const notes = [];
	if (!accountHome) {
		return { env: next, notes };
	}
	if (next.HOME && !samePath(platform, next.HOME, accountHome)) {
		notes.push(`note: HOME was ${next.HOME}; using ${accountHome}`);
		next.HOME = accountHome;
	} else if (!next.HOME) {
		next.HOME = accountHome;
	}
	if (platform === 'win32') {
		if (next.USERPROFILE && !samePath(platform, next.USERPROFILE, accountHome)) {
			notes.push(`note: USERPROFILE was ${next.USERPROFILE}; using ${accountHome}`);
			next.USERPROFILE = accountHome;
		} else if (!next.USERPROFILE) {
			next.USERPROFILE = accountHome;
		}
	}
	return { env: next, notes };
}

/** Drop host-editor variables. Windows env keys are matched case-insensitively. */
export function scrubEnv(env) {
	const next = {};
	for (const [key, value] of Object.entries(env)) {
		const lower = key.toLowerCase();
		if (DROP.has(lower) || lower.startsWith('git_config_')) {
			continue;
		}
		next[key] = value;
	}
	return next;
}

export function prependPath(env, dir, platform) {
	const key = Object.keys(env).find(name => name.toLowerCase() === 'path') ?? 'PATH';
	const delimiter = platform === 'win32' ? path.win32.delimiter : path.posix.delimiter;
	const current = env[key] ?? '';
	env[key] = current ? `${dir}${delimiter}${current}` : dir;
	return env;
}

/**
 * Absolute paths where the pinned Node is commonly installed.
 * `version` is without a leading v.
 */
export function candidateNodeBins(version, env, platform, home) {
	const want = normalizeVersion(version);
	const bins = [];
	const add = (...parts) => {
		if (parts.every(part => typeof part === 'string' && part.length > 0)) {
			bins.push(pathApi(platform).join(...parts));
		}
	};
	if (platform === 'win32') {
		const nvmHome = env.NVM_HOME || (env.APPDATA && path.win32.join(env.APPDATA, 'nvm'));
		add(nvmHome, `v${want}`, 'node.exe');
		add(nvmHome, want, 'node.exe');
		const fnmRoots = [
			env.FNM_DIR,
			env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'fnm'),
			home && path.win32.join(home, 'AppData', 'Local', 'fnm'),
			home && path.win32.join(home, '.fnm'),
		];
		for (const root of fnmRoots) {
			add(root, 'node-versions', `v${want}`, 'installation', 'node.exe');
		}
		add(home, '.volta', 'tools', 'image', 'node', want, 'node.exe');
		add(env.ProgramFiles, 'nodejs', 'node.exe');
		return bins;
	}
	const nvmDir = env.NVM_DIR || (home && path.posix.join(home, '.nvm'));
	add(nvmDir, 'versions', 'node', `v${want}`, 'bin', 'node');
	const fnmRoots = [
		env.FNM_DIR,
		home && path.posix.join(home, '.local', 'share', 'fnm'),
		home && path.posix.join(home, '.fnm'),
		home && path.posix.join(home, 'Library', 'Application Support', 'fnm'),
	];
	for (const root of fnmRoots) {
		add(root, 'node-versions', `v${want}`, 'installation', 'bin', 'node');
	}
	add(home, '.volta', 'tools', 'image', 'node', want, 'bin', 'node');
	add(home, '.asdf', 'installs', 'nodejs', want, 'bin', 'node');
	add(home, '.local', 'share', 'mise', 'installs', 'node', want, 'bin', 'node');
	add(home, 'n', 'versions', 'node', want, 'bin', 'node');
	add('/usr/local', 'n', 'versions', 'node', want, 'bin', 'node');
	return bins;
}

export function probeNodeVersion(bin) {
	try {
		return execFileSync(bin, ['-v'], {
			encoding: 'utf8',
			timeout: 10000,
			windowsHide: true,
		}).trim();
	} catch {
		return '';
	}
}

/**
 * The pinned Node binary, or undefined. `io` is injectable for tests:
 * `{ exists(path), version(path), execPath }`.
 */
export function findNodeBinary(version, env, platform, home, io = defaultIo()) {
	const want = normalizeVersion(version);
	for (const bin of candidateNodeBins(want, env, platform, home)) {
		if (io.exists(bin) && versionsMatch(io.version(bin), want)) {
			return bin;
		}
	}
	if (io.execPath && versionsMatch(io.version(io.execPath), want)) {
		return io.execPath;
	}
	return undefined;
}

function defaultIo() {
	return {
		exists: existsSync,
		version: probeNodeVersion,
		execPath: process.execPath,
	};
}

/**
 * How to start the editor. On Windows, `scripts/code.bat` through the shell so
 * cmd quoting stays correct. On macOS and Linux, `scripts/code.sh` via bash.
 */
export function editorCommand(editorDirPath, platform, args) {
	if (platform === 'win32') {
		return {
			command: 'scripts\\code.bat',
			args,
			cwd: editorDirPath,
			shell: true,
		};
	}
	const script = path.posix.join(editorDirPath, 'scripts', 'code.sh');
	return {
		command: 'bash',
		args: [script, ...args],
		cwd: editorDirPath,
		shell: false,
	};
}
