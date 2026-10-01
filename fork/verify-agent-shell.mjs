#!/usr/bin/env node
// Checks the hivemind shell end to end through HivemindIDE's own code: the
// main-process shell service and the route/overlay functions, compiled to out/,
// driving a built hivemind-agent against a fake OpenAI-compatible provider.
// Three nodes on three routes; each must be answered by its own model with its
// own provider's key. No network, no real keys.
//
//   (cd hivemindide-editor && npm run transpile-client)
//   node fork/verify-agent-shell.mjs [editor-out] [hivemind-agent]   (default: found beside the editor)
//
// Run it with plain Node 22.19+, not from a terminal inside an editor that sets
// ELECTRON_RUN_AS_NODE.
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

const here = dirname(new URL(import.meta.url).pathname);
const editorRoot = join(here, '..', 'hivemindide-editor');
const editorOut = resolve(process.argv[2] ?? join(editorRoot, 'out'));
// Unset by default, so the check also covers finding the runtime beside the editor.
const runtimePath = process.argv[3] ? resolve(process.argv[3]) : undefined;
const { HivemindShellMainService } = await import(join(editorOut, 'vs/platform/hivemindide/electron-main/hivemindShellMainService.js'));
const { buildShellOverlay, findRouteChoice, shellRoutes } = await import(join(editorOut, 'vs/workbench/contrib/hivemindide/common/shellRoutes.js'));
const { parseFailoverProviders } = await import(join(editorOut, 'vs/workbench/contrib/hivemindide/common/providerFailover.js'));

// --- fake provider -----------------------------------------------------------
const seen = [];
const server = createServer((req, res) => {
	let body = '';
	req.on('data', c => body += c);
	req.on('end', () => {
		const parsed = JSON.parse(body || '{}');
		seen.push({ model: parsed.model, auth: req.headers.authorization, host: req.headers.host });
		res.writeHead(200, { 'content-type': 'text/event-stream' });
		for (const w of `Hello from ${parsed.model}.`.split(' ')) {
			res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: parsed.model, choices: [{ index: 0, delta: { role: 'assistant', content: w + ' ' }, finish_reason: null }] })}\n\n`);
		}
		res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: parsed.model, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`);
		res.end('data: [DONE]\n\n');
	});
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/v1`;

// --- what ShellAgentService builds from the user's settings -------------------
const providers = parseFailoverProviders([
	{ name: 'Alpha', url, model: 'fast-1', models: ['smart-1'] },
	{ name: 'Beta', url, model: 'fast-2' },
]);
const routes = shellRoutes(providers);
const { overlay, keyVariables } = buildShellOverlay(providers, routes[0]);
const secrets = { [keyVariables.get('Alpha')]: 'key-alpha', [keyVariables.get('Beta')]: 'key-beta' };
console.log('routes:', routes.map(r => r.id).join(', '));

const log = { info: m => console.log('  [log]', m), trace() { }, warn: m => console.log('  [warn]', m) };
const shell = new HivemindShellMainService(log, { appRoot: editorRoot });
const events = [];
shell.onDidEvent(e => events.push(e));
shell.onDidRequestPermission(p => console.log('  permission requested:', p.title));

const timeout = setTimeout(() => { console.error('TIMEOUT'); process.exit(2); }, 120_000);
try {
	await shell.ensureStarted({ runtimePath, homePath: mkdtempSync(join(tmpdir(), 'hive-home-')), overlay, secrets });
	const results = [];
	// One node per route, as spawns do: parent on Alpha/fast-1, children on Alpha/smart-1 and Beta/fast-2.
	for (const route of [routes[0], routes[1], routes[2]]) {
		const session = await shell.newSession(process.cwd());
		const choice = findRouteChoice(session.routes, route);
		if (!choice) {
			throw new Error(`no choice for ${route.id} in ${JSON.stringify(session.routes)}`);
		}
		if (choice !== session.route) {
			await shell.setOption(session.sessionId, 'model', choice);
		}
		const stopReason = await shell.prompt(session.sessionId, 'Say hello.');
		const text = events.filter(e => e.sessionId === session.sessionId && e.kind === 'text').map(e => e.text).join('').trim();
		results.push({ route: route.id, stopReason, text });
		await shell.closeSession(session.sessionId);
	}
	console.log(JSON.stringify(results, null, 2));
	console.log('provider saw:', JSON.stringify(seen.map(s => `${s.model} ${s.auth}`)));
	console.log('event kinds:', [...new Set(events.map(e => e.kind))].join(', '));
	const expected = [['Alpha/fast-1', 'fast-1', 'key-alpha'], ['Alpha/smart-1', 'smart-1', 'key-alpha'], ['Beta/fast-2', 'fast-2', 'key-beta']];
	const ok = expected.every(([id, model, key], i) => results[i].text === `Hello from ${model}.` && seen[i]?.model === model && seen[i]?.auth === `Bearer ${key}`);
	console.log(ok ? 'PASS' : 'FAIL');
	process.exitCode = ok ? 0 : 1;
} catch (err) {
	console.error('FAILED:', err.message);
	process.exitCode = 1;
} finally {
	clearTimeout(timeout);
	await shell.stop();
	server.close();
}
