/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE hivemind shell: agent CLIs the user already has installed.
 *
 *  Finds Claude Code, Cursor and Codex wherever their installers put them, and
 *  runs one turn at a time in each CLI's headless mode. The CLI keeps its own
 *  login, limits and conversation; HivemindIDE keeps the CLI's session id and
 *  resumes it on the next turn.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, execFile, spawn } from 'child_process';
import { promises as fs } from 'fs';
import { userInfo } from 'os';
import { delimiter, dirname, join } from '../../../base/common/path.js';
import { isWindows } from '../../../base/common/platform.js';
import { CliAgentEvent, parseCliAgentLine, parseModelList } from '../common/cliAgentEvents.js';
import { HivemindCliPermissions, HivemindShellStopReason, IHivemindCliAgent } from '../common/hivemindShell.js';

interface ICliAgentSpec {
	readonly id: string;
	readonly name: string;
	/** Models to offer; `listModels` asks the CLI instead, when it can answer. */
	readonly models: readonly string[];
	readonly listModels?: readonly string[];
	/** The CLI takes a session id chosen in advance, so it can be resumed after a restart. */
	readonly presetSession?: boolean;
	/** How the user signs it in, for when it says it is not. */
	readonly signIn: string;
	args(turn: ICliTurn): string[];
}

export interface ICliTurn {
	readonly prompt: string;
	readonly cwd: string;
	readonly model: string;
	readonly permissions: HivemindCliPermissions;
	/** The CLI's session id; `resume` false when this turn starts it. */
	readonly session?: string;
	readonly resume: boolean;
}

const withModel = (model: string, flag: string) => model && model !== 'default' ? [flag, model] : [];

const SPECS: readonly ICliAgentSpec[] = [
	{
		id: 'claude',
		name: 'Claude Code',
		models: ['default', 'opus', 'sonnet', 'haiku'],
		presetSession: true,
		signIn: 'run `claude` in a terminal and type /login',
		args: turn => [
			'-p', turn.prompt, '--output-format', 'stream-json', '--verbose',
			// Headless, `default` refuses whatever needs approval (edits, commands) and reads freely:
			// read-only without `plan`, which would have it write plans instead of answering.
			'--permission-mode', turn.permissions === 'readOnly' ? 'default' : turn.permissions === 'full' ? 'bypassPermissions' : 'acceptEdits',
			...withModel(turn.model, '--model'),
			...(turn.session ? [turn.resume ? '--resume' : '--session-id', turn.session] : []),
		],
	},
	{
		id: 'cursor-agent',
		name: 'Cursor',
		models: ['auto'],
		listModels: ['--list-models'],
		signIn: 'run `cursor-agent login` in a terminal',
		args: turn => [
			'-p', turn.prompt, '--output-format', 'stream-json', '--trust', '--workspace', turn.cwd,
			// Without --force, commands that need approval are refused (headless cannot ask).
			...(turn.permissions === 'full' ? ['--force'] : []),
			...withModel(turn.model === 'auto' ? 'default' : turn.model, '--model'),
			...(turn.session && turn.resume ? ['--resume', turn.session] : []),
		],
	},
	{
		id: 'codex',
		name: 'Codex',
		models: ['default'],
		signIn: 'run `codex login` in a terminal',
		args: turn => [
			'exec', '--json', '--skip-git-repo-check',
			...(turn.permissions === 'readOnly' ? ['--sandbox', 'read-only'] : turn.permissions === 'full' ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--full-auto']),
			...withModel(turn.model, '-m'),
			...(turn.session && turn.resume ? ['resume', turn.session] : []),
			turn.prompt,
		],
	},
];

export function cliAgentSpec(id: string): ICliAgentSpec | undefined {
	return SPECS.find(s => s.id === id);
}

/**
 * The account's home folder, from the system rather than $HOME. An editor started
 * from a sandboxed shell (an agent's terminal) can carry a $HOME pointing at a
 * scratch folder, where no CLI finds its sign-in: "Not logged in".
 */
export function accountHome(): string {
	try {
		return userInfo().homedir;
	} catch {
		return process.env.HOME ?? '';
	}
}

/** Where installers put these CLIs, besides PATH: an editor started from the Dock has almost no PATH. */
async function searchDirs(): Promise<string[]> {
	const home = accountHome();
	const dirs = [
		...(process.env.PATH ?? '').split(delimiter),
		join(home, '.local', 'bin'), join(home, '.claude', 'local'), join(home, '.npm-global', 'bin'), join(home, '.bun', 'bin'),
		join(home, '.volta', 'bin'), join(home, '.cargo', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
	];
	try {
		const nvm = join(home, '.nvm', 'versions', 'node');
		for (const version of (await fs.readdir(nvm)).sort().reverse()) {
			dirs.push(join(nvm, version, 'bin'));
		}
	} catch {
		// no nvm
	}
	return [...new Set(dirs.filter(Boolean))];
}

/**
 * Variables that tie a process to one running Claude Code session. An editor
 * started from a Claude Code terminal inherits them, and a `claude` spawned with
 * them authenticates through that (usually long gone) session: "Not logged in".
 * User configuration (ANTHROPIC_API_KEY, CLAUDE_CODE_USE_BEDROCK, ...) is kept.
 */
const AGENT_SESSION_VARIABLES = new Set([
	'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_AGENT_SDK_VERSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH',
	'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET',
	'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_ENABLE_TASKS', 'CLAUDE_CODE_ENABLE_SDK_FILE_CHECKPOINTING', 'CLAUDE_CODE_SSE_PORT',
]);

/**
 * The editor's environment for an agent it starts: without Electron's, VS Code's or
 * another agent session's variables, and with the account's real home folder.
 */
export function agentEnvironment(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !key.startsWith('ELECTRON_') && !key.startsWith('VSCODE_') && !AGENT_SESSION_VARIABLES.has(key)) {
			env[key] = value;
		}
	}
	const home = accountHome();
	if (home) {
		env.HOME = home;
	}
	return env;
}

/** The environment a CLI runs in: agentEnvironment(), with the search dirs on PATH. */
export async function cliEnvironment(executable: string): Promise<Record<string, string>> {
	const env = agentEnvironment();
	env.PATH = [dirname(executable), ...await searchDirs()].join(delimiter);
	return env;
}

export async function detectCliAgents(): Promise<IHivemindCliAgent[]> {
	const dirs = await searchDirs();
	const found: IHivemindCliAgent[] = [];
	for (const spec of SPECS) {
		for (const dir of dirs) {
			const path = join(dir, isWindows ? `${spec.id}.cmd` : spec.id);
			try {
				await fs.access(path, fs.constants.X_OK);
			} catch {
				continue;
			}
			const env = await cliEnvironment(path);
			const version = await run(path, ['--version'], env);
			if (version === undefined) {
				continue;
			}
			let models = spec.models;
			if (spec.listModels) {
				const listed = parseModelList(await run(path, [...spec.listModels], env) ?? '');
				if (listed.length) {
					models = listed;
				}
			}
			found.push({ id: spec.id, name: spec.name, path, version: version.split('\n')[0].trim(), models });
			break;
		}
	}
	return found;
}

function run(path: string, args: string[], env: Record<string, string>): Promise<string | undefined> {
	return new Promise(resolve => {
		execFile(path, args, { env, timeout: 15_000 }, (err, stdout) => resolve(err ? undefined : String(stdout)));
	});
}

export interface ICliRunResult {
	readonly stopReason: HivemindShellStopReason;
	/** The CLI's session id, to resume with next turn. */
	readonly session?: string;
}

/**
 * Runs one turn. `onEvent` gets the CLI's events as they arrive. Rejects with a
 * message failover can classify: a usage limit says so with its reset time.
 */
export function runCliTurn(agent: IHivemindCliAgent, turn: ICliTurn, onEvent: (event: CliAgentEvent) => void, register: (child: ChildProcess) => void): Promise<ICliRunResult> {
	const spec = cliAgentSpec(agent.id);
	if (!spec) {
		return Promise.reject(new Error(`Unknown agent CLI ${agent.id}`));
	}
	return cliEnvironment(agent.path).then(env => new Promise<ICliRunResult>((resolve, reject) => {
		const child = spawn(agent.path, spec.args(turn), { cwd: turn.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
		register(child);
		let session = turn.session;
		let limit: Extract<CliAgentEvent, { kind: 'limit' }> | undefined;
		let settled = false;
		let stderr = '';
		let buffer = '';
		const finish = (result: ICliRunResult | Error) => {
			if (settled) {
				return;
			}
			settled = true;
			if (result instanceof Error) {
				reject(result);
			} else {
				resolve(result);
			}
		};
		// "Not logged in", "Authentication required": say how to fix it; failover reads "not signed in" as auth.
		const describe = (error: string) => /not logged in|please run \/login|authentication required|agent login|codex login/i.test(error)
			? `${agent.name} is not signed in on this machine: ${spec.signIn}, then try again. (${error.trim()})`
			: `${agent.name}: ${error.trim()}`;
		const limitMessage = () => {
			const wait = limit?.resetsAt ? Math.max(1, Math.round(limit.resetsAt - Date.now() / 1000)) : undefined;
			return `${agent.name} usage limit reached${limit?.limitType ? ` (${limit.limitType.replace(/_/g, ' ')})` : ''}${wait ? ` (retry after ${wait}s)` : ''}`;
		};
		child.stdout?.setEncoding('utf8');
		child.stdout?.on('data', (chunk: string) => {
			buffer += chunk;
			let newline: number;
			while ((newline = buffer.indexOf('\n')) >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				for (const event of line ? parseCliAgentLine(agent.id, line) : []) {
					if (event.kind === 'session') {
						session = event.id;
					} else if (event.kind === 'limit') {
						limit = event.rejected ? event : undefined;
					} else if (event.kind === 'done') {
						finish(event.error
							? new Error(limit ? `${limitMessage()}: ${event.error}` : describe(event.error))
							: { stopReason: event.stopReason ?? 'end_turn', session });
					}
					onEvent(event);
				}
			}
		});
		child.stderr?.setEncoding('utf8');
		child.stderr?.on('data', (chunk: string) => stderr = (stderr + chunk).slice(-4000));
		child.on('error', err => finish(new Error(`${agent.name} could not start: ${err.message}`)));
		child.on('exit', (code, signal) => {
			if (signal) {
				finish({ stopReason: 'cancelled', session });
			} else if (limit) {
				finish(new Error(limitMessage()));
			} else if (code === 0) {
				finish({ stopReason: 'end_turn', session });
			} else {
				finish(new Error(stderr.trim() ? describe(stderr.trim().split('\n').slice(-6).join('\n')) : `${agent.name} exited with code ${code}`));
			}
		});
	}));
}
