#!/usr/bin/env node
// Turns an upstream agent-runtime checkout into hivemind-agent: the ACP agent
// shell HivemindIDE runs every hivemind node in.
//
//   node fork/rebrand-agent.mjs [upstream-checkout] [output-dir]
//
// Defaults: ../hivemind-agent-upstream -> ../hivemind-agent (beside this repo).
//
// Idempotent, like apply-branding.sh: the output is regenerated from the
// upstream checkout every run, so taking an upstream update is "pull upstream,
// run this, build, commit". The output's own .git is kept; nothing of the
// upstream history is copied.
//
// What it does, in order:
//   1. exports upstream's tracked files (no history);
//   2. keeps only what the ACP shell needs: the CLI, the base and ACP profiles
//      and everything they depend on; drops the web UI, desktop app, SDKs,
//      vendor-specific model adapters and account login, telemetry, feedback,
//      bundled third-party agents, and upstream's docs and CI;
//   3. removes every reference to what was dropped (manifests, TypeScript
//      project files, profile compositions, tests that exercised it);
//   4. renames everything to Hivemind;
//   5. writes LICENSE and THIRD_PARTY_NOTICES.md: the upstream copyright and
//      license are kept there, as their MIT license requires, and nowhere else;
//   6. fails if any trace of the upstream brand is left outside that notice.

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

const here = dirname(new URL(import.meta.url).pathname);
const root = resolve(here, '..', '..');
const upstream = resolve(process.argv[2] ?? join(root, 'hivemind-agent-upstream'));
const out = resolve(process.argv[3] ?? join(root, 'hivemind-agent'));

// ---- What to keep ---------------------------------------------------------------

const OLD_SCOPE = '@' + 'deep' + 'seek-ai/'; // split so this file passes its own trace scan
const OLD_PREFIX = OLD_SCOPE + 'd' + 'sh';

/**
 * Where the kept package set is grown from: the launcher and the profiles HivemindIDE
 * boots, and the type generator the build runs (a build tool, so no runtime package
 * depends on it).
 */
const ROOTS = ['apps/cli', 'packages/bundle/base', 'packages/bundle/acp-app', 'packages/typert/generator'];

/** Packages never kept, whatever depends on them. Short names, after the scope and prefix. */
const DROP_PACKAGES = [
	// vendor-specific model adapters, account login and their request extensions
	'-llm-' + 'deep' + 'seek', '-llm-' + 'deep' + 'seek-account', '-llm-' + 'deep' + 'seek-api-key',
	'-' + 'deep' + 'seek-llm-api-extensions', '-plugin-package-inventory-' + 'deep' + 'seek',
	'-' + 'deep' + 'seek-account-platform', '-' + 'deep' + 'seek-account', '-session-log-' + 'deep' + 'seek', '-web-search-' + 'deep' + 'seek',
	// telemetry and feedback, which report to the upstream vendor
	'-otel', '-session-telemetry-otel', '-product-telemetry-otel', '-command-feedback', '-message-feedback',
	// bundled third-party agent binaries and MPL-licensed office conversion
	'-subagent-claude-code', '-office-to-pdf', '-skill-office',
	// the web UI, desktop app and SDK front ends: HivemindIDE is the UI
	'-web-app', '-desktop', '-desktop-host', '-sdk-app', '-sdk-minimal', '-sdk-server', '-sdk-client',
	'-client-ui-agent-preset', '-client-ui-cordis', '-cordis-client-runner', '-experimental-voice-input-bundle',
];

/** Top-level paths dropped outright. */
const DROP_PATHS = [
	'apps/web', 'apps/desktop', 'apps/desktop-host', 'website', 'python', 'benchmarks', 'snapshots', 'docs',
	'.agents', '.claude', '.github', '.gitlab-ci.yml', 'lefthook.yml', '.jscpd.json', '.rgignore', 'Makefile',
	'AGENTS.md', 'CLAUDE.md', 'BENCHMARK.md', 'CONTRIBUTING.md', 'SAFETY.md', 'README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
	'vitest.bench.config.ts', 'vitest.e2e.config.ts', 'vitest.expected.config.ts', 'vitest.snapshot.config.ts',
	'vitest.web-stress.config.ts', 'vitest.web.config.ts', 'vitest.web.perf.config.ts', 'tsconfig.client.json', 'tsconfig.base.client.json',
	'scripts',
];

/**
 * Files dropped wherever they are: upstream documentation (it describes upstream's
 * product, links docs that are gone, and is rewritten where HivemindIDE needs any)
 * translations, and browser-build project files (nothing is built for a browser).
 * The root README, LICENSE and notices are written afresh.
 */
const DROP_FILE = /(\.md|\.i18n\.yaml|(^|\/)tsconfig\.client\.json)$/;

/** Package folders dropped whatever depends on them: the web UI's components. */
const DROP_PACKAGE_DIRS = ['packages/client/'];
const DROPPED_DIR_LINE = /["'](\.\/)?(packages\/client|apps\/(web|desktop|desktop-host)|scripts|benchmarks|python|website|snapshots|docs)\//;

// ---- Renames --------------------------------------------------------------------

const V = 'deep' + 'seek', Vc = 'Deep' + 'Seek', VU = 'DEEP' + 'SEEK';
const HOME_URL = 'https://github.com/BimaPDev/HivemindIDE';

/**
 * Source that is about the upstream vendor rather than named after it: rewritten
 * to be vendor-neutral before the renames. Each entry is [pattern, replacement].
 */
const TEXT_FIXES = [
	// The ACP profile's default route: HivemindIDE's overlay always sets one.
	[new RegExp(`\\n(\\s+)config:\\n\\1  provider: ${V}-official\\n\\1  model: [^\\n]+`, 'g'), ''],
	// Links and identities.
	[new RegExp(`https://github\\.com/${V}-ai/${V}-harness`, 'g'), HOME_URL],
	[new RegExp(`\\(\\+https://github\\.com/${V}-ai\\)`, 'g'), `(+${HOME_URL})`],
	[new RegExp(`${V}-ai/${V}-harness`, 'g'), 'BimaPDev/HivemindIDE'],
	[new RegExp(`@${V}-ai\\\\/`, 'g'), '@hivemindide\\/'],
	[new RegExp(`@${V}-ai(?![/\\\\\\w-])`, 'g'), '@hivemindide'],
	// Vendor endpoints and keys used as examples, or passed through the environment.
	[new RegExp(`^.*'${VU}_BASE_URL', '${VU}_SEARCH_BASE_URL',\\n`, 'gm'), ''],
	[new RegExp(`${VU}_API_KEY`, 'g'), 'PROVIDER_API_KEY'],
	// Identifiers of the dropped account provider and its event log, kept consistent.
	[new RegExp(`session-log-${V}`, 'g'), 'session-log-provider'],
	[new RegExp(`${V}-account`, 'g'), 'provider-account'],
	[new RegExp(`${V}Account`, 'g'), 'providerAccount'],
	[new RegExp(`${V}LlmApiExtensions`, 'g'), 'providerLlmApiExtensions'],
	[new RegExp(`web/${V}-search-llm-request`, 'g'), 'web/provider-search-llm-request'],
	[new RegExp(`${V.slice(0, 4)}Seek(?=[A-Z])`, 'g'), 'provider'],
	[new RegExp(`for official ${Vc} requests`, 'g'), 'for provider requests'],
	[new RegExp(`${Vc}(?=[A-Z])`, 'g'), 'Provider'],
	// The vendor as a built-in catalog provider (it stays reachable as a custom route).
	[new RegExp(`^\\s*'${V}': true,\\n`, 'gm'), ''],
	[new RegExp(`thinkingFormat: ${V}`, 'g'), 'thinkingFormat: openai'],
	// ... which leaves the library's format table incomplete: it stops being a drift gate.
	[/const THINKING_FORMAT_GATE: Record<PiAiThinkingFormat, true> = \{/g, 'const THINKING_FORMAT_GATE: Partial<Record<PiAiThinkingFormat, true>> = {'],
	// The base profile's note on the vendor's web search, which went with it.
	[new RegExp(` ${Vc}\\n(\\s*# )search resolves[\\s\\S]*?base-URL override\\. `, 'g'), '\n$1'],
	[new RegExp(`^\\s*searchProvider: ${V}-official\\n`, 'gm'), ''],
	[new RegExp(`shipped ${Vc} route gets`, 'g'), 'shipped search route gets'],
	// Prose that names the vendor as an example.
	[new RegExp(`${Vc} and library-backed`, 'g'), 'Native and library-backed'],
	[new RegExp(`\\(${Vc}'s \\\`prompt_tokens\\\`\\)`, 'g'), '(OpenAI-style `prompt_tokens`)'],
	[new RegExp(`${Vc} function-name`, 'g'), 'provider function-name'],
	[new RegExp(`providers: \\{ ${V}: \\{`, 'g'), 'providers: { openai: {'],
	[new RegExp(`keyed \\\`${V}-official\\\``, 'g'), 'keyed `openai`'],
	[new RegExp(`Exa and ${Vc} return none`, 'g'), 'Exa returns none'],
	[new RegExp(`\\(\\\`llm-${V}\\\`, `, 'g'), '('],
	[new RegExp(`"pi-ai-backed ${Vc} adapter[^"]*"`, 'g'), '"pi-ai-backed multi-provider LLM adapter"'],
];

const d = 'd', s = 'sh', D = 'D', S = 'SH';
/** Ordered: the most specific first. */
const RENAMES = [
	[new RegExp(escape(OLD_PREFIX) + '(?![A-Za-z])', 'g'), '@hivemindide/hive'],
	[new RegExp(escape(OLD_SCOPE), 'g'), '@hivemindide/'],
	[new RegExp('Deep' + 'Seek Harness', 'g'), 'Hivemind Agent'],
	[new RegExp('deep' + 'seek[-_]harness', 'gi'), 'hivemind-agent'],
	[new RegExp('(?<![A-Za-z])' + D + S + '(?![a-z])', 'g'), 'HIVE'],
	[new RegExp('(?<![A-Za-z])' + D + s + '(?![a-z])', 'g'), 'Hive'],
	[new RegExp('(?<![A-Za-z])' + d + s + '(?![a-z])', 'g'), 'hive'],
];

/** What the trace scan looks for. */
const TRACE = new RegExp('deep' + 'seek|(?<![A-Za-z])' + d + s + '(?![a-z])', 'i');

// ---- Run ------------------------------------------------------------------------

function main() {
	if (!existsSync(join(upstream, '.git'))) {
		fail(`No upstream checkout at ${upstream}`);
	}
	log(`upstream ${upstream} @ ${git(upstream, 'rev-parse', '--short', 'HEAD')}`);
	exportTree();
	const dropped = prunePackages();
	pruneReferences(dropped);
	rename();
	writeRootFiles();
	pruneLockfile();
	scanForTraces();
	log(`done: ${out}`);
}

function exportTree() {
	const tmp = `${out}.tmp`;
	rmSync(tmp, { recursive: true, force: true });
	mkdirSync(tmp, { recursive: true });
	execFileSync('sh', ['-c', `git -C "${upstream}" archive --format=tar HEAD | tar -x -C "${tmp}"`], { stdio: 'inherit' });
	if (existsSync(join(out, '.git'))) {
		renameSync(join(out, '.git'), join(tmp, '.git'));
	}
	for (const keep of ['node_modules']) {
		// Kept between runs purely to make re-installs fast; never committed.
		if (existsSync(join(out, keep))) {
			renameSync(join(out, keep), join(tmp, keep));
		}
	}
	rmSync(out, { recursive: true, force: true });
	renameSync(tmp, out);
	for (const path of DROP_PATHS) {
		rmSync(join(out, path), { recursive: true, force: true });
	}
	for (const file of walk(out)) {
		if (DROP_FILE.test(rel(file))) {
			rmSync(file);
		}
	}
	removeDanglingLinks();
}

/** Symlinks whose target was dropped. */
function removeDanglingLinks() {
	for (const file of walk(out)) {
		if (!existsSync(file)) {
			rmSync(file);
		}
	}
}

/** Keeps the dependency closure of ROOTS, minus DROP_PACKAGES. Returns the dropped packages. */
function prunePackages() {
	const packages = new Map(); // name -> dir
	for (const file of walk(out)) {
		if (file.endsWith(`${sep}package.json`) && !rel(file).includes('node_modules/')) {
			const manifest = readJson(file);
			// The workspace root carries the scope too, but it is not a package to keep or drop.
			if (manifest?.name?.startsWith(OLD_SCOPE) && dirname(file) !== out) {
				packages.set(manifest.name, dirname(file));
			}
		}
	}
	const drop = new Set(DROP_PACKAGES.map(p => OLD_PREFIX + p));
	const keep = new Set();
	const stack = [...packages].filter(([, dir]) => ROOTS.includes(rel(dir))).map(([name]) => name);
	while (stack.length) {
		const name = stack.pop();
		if (keep.has(name) || drop.has(name) || !packages.has(name)) {
			continue;
		}
		keep.add(name);
		const manifest = readJson(join(packages.get(name), 'package.json'));
		for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
			stack.push(...Object.keys(manifest[section] ?? {}).filter(dep => dep.startsWith(OLD_SCOPE)));
		}
	}
	// Native addons and the vendored framework ship with whatever uses them.
	for (const [name, dir] of packages) {
		if (rel(dir).startsWith('native/') || rel(dir).startsWith('vendor/')) {
			keep.add(name);
		}
	}
	// UI packages go, except those whose runtime side (everything outside src/client/)
	// kept runtime code imports. Imports decide, not manifests, which list the UI too.
	const uiDirs = new Set([...packages].filter(([name, dir]) => DROP_PACKAGE_DIRS.some(prefix => `${rel(dir)}/`.startsWith(prefix)) || /-client-ui-/.test(name)).map(([, dir]) => dir));
	const isUi = dir => uiDirs.has(dir);
	const runtimeImports = dir => !existsSync(join(dir, 'src')) ? [] : walk(join(dir, 'src'))
		.filter(file => !rel(file).includes('/src/client/') && /\.[cm]?tsx?$/.test(file))
		.flatMap(file => [...readFileSync(file, 'utf8').matchAll(new RegExp(`['"](?<dep>${escape(OLD_SCOPE)}[a-z0-9-]+)`, 'g'))].map(m => m.groups.dep));
	const needed = new Set();
	const pending = [...keep].filter(name => packages.has(name) && !isUi(packages.get(name))).flatMap(name => runtimeImports(packages.get(name)));
	while (pending.length) {
		const name = pending.pop();
		const dir = packages.get(name);
		if (!dir || !isUi(dir) || needed.has(name) || !keep.has(name)) {
			continue;
		}
		needed.add(name);
		pending.push(...runtimeImports(dir));
	}
	const dropped = new Map([...packages].filter(([name, dir]) => !keep.has(name) || (isUi(dir) && !needed.has(name))));
	for (const dir of dropped.values()) {
		rmSync(dir, { recursive: true, force: true });
	}
	// Package groups left empty (packages/client, ...) go too.
	for (const group of readdirSync(join(out, 'packages'), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
		const dir = join(out, 'packages', group.name);
		if (!readdirSync(dir).some(entry => existsSync(join(dir, entry, 'package.json')))) {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	removeDanglingLinks();
	log(`kept ${packages.size - dropped.size} packages, dropped ${dropped.size}`);
	return dropped;
}

function pruneReferences(dropped) {
	const names = new Set(dropped.keys());
	const dirs = [...dropped.values()].map(dir => rel(dir));
	const mentionsDropped = text => [...names].some(name => new RegExp(escape(name) + '(?![A-Za-z0-9-])').test(text)) || dirs.some(dir => text.includes(dir + '/') || text.includes(dir + '"') || text.includes(dir + "'"));

	for (const file of walk(out)) {
		const path = rel(file);
		if (path.includes('node_modules/')) {
			continue;
		}
		if (/(^|\/)(tests?|fixtures|__tests__)\/|\.(spec|e2e|test|snapshot)\.[cm]?tsx?$/.test(path)) {
			// Tests of what was dropped, or that stand it in as their model route, go with it.
			const text = readFileSync(file, 'utf8');
			if (mentionsDropped(text) || TRACE.test(text) || TRACE.test(path)) {
				rmSync(file);
			}
		} else if (file.endsWith('package.json')) {
			const manifest = readJson(file);
			// Upstream's repository, issue tracker and site.
			let changed = ['repository', 'homepage', 'bugs'].some(key => key in manifest);
			delete manifest.repository;
			delete manifest.homepage;
			delete manifest.bugs;
			for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies', 'peerDependenciesMeta']) {
				for (const dep of Object.keys(manifest[section] ?? {})) {
					if (names.has(dep)) {
						delete manifest[section][dep];
						changed = true;
					}
				}
			}
			if (changed) {
				writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
			}
		} else if (/tsconfig[^/]*\.json$/.test(path)) {
			pruneTsconfig(file, mentionsDropped);
		} else if (/(^|\/)vitest\.[a-z]+\.ts$/.test(path)) {
			// One entry per line in these lists; a line naming a dropped package or path goes.
			const text = readFileSync(file, 'utf8');
			const next = text.split('\n').filter(line => !mentionsDropped(line) && !DROPPED_DIR_LINE.test(line)).join('\n');
			if (next !== text) {
				writeFileSync(file, next);
			}
		} else if (/\.ya?ml$/.test(path) && !path.endsWith('pnpm-lock.yaml')) {
			const text = readFileSync(file, 'utf8');
			const next = removeYamlItems(text, block => mentionsDropped(block));
			if (next !== text) {
				writeFileSync(file, next);
			}
		}
	}

	// Packages built through the browser-bundle helper had their Node library built in
	// the browser pass, which is gone: without their own config, the root config
	// builds them like every other runtime package. The helper goes with the UI.
	for (const file of walk(out)) {
		if (file.endsWith(`${sep}tsdown.config.ts`) && rel(file) !== 'tsdown.config.ts' && readFileSync(file, 'utf8').includes('tsdown.client.ts')) {
			rmSync(file);
		}
	}
	rmSync(join(out, 'packages', 'client', 'tsdown.client.ts'), { force: true });

	// Tests left importing a helper that went with them go too, until nothing changes.
	for (let changed = true; changed;) {
		changed = false;
		for (const file of walk(out)) {
			const path = rel(file);
			if (path.includes('node_modules/') || !/\.[cm]?tsx?$/.test(path) || !/(^|\/)(tests?|fixtures|__tests__)\/|\.(spec|e2e|test|snapshot)\.[cm]?tsx?$/.test(path)) {
				continue;
			}
			const imports = [...readFileSync(file, 'utf8').matchAll(/from ['"](?<target>\.\.?\/[^'"]+)['"]/g)].map(m => m.groups.target);
			if (imports.some(target => !existsSync(resolve(dirname(file), target)))) {
				rmSync(file);
				changed = true;
			}
		}
	}

	// The root manifest builds only the runtime.
	const rootManifest = readJson(join(out, 'package.json'));
	rootManifest.name = OLD_PREFIX + '-root';
	rootManifest.workspaces = ['vendor/*', 'packages/*/*', 'native/system', 'native/system/packages/*', 'apps/*'];
	rootManifest.scripts = {
		'build': 'pnpm run build:native-system && pnpm run build:lib',
		'build:native-system': 'tsx native/system/scripts/build.ts --host-addon-only',
		'build:lib': 'node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host',
		'test': 'vitest run',
	};
	// Git hooks, and the packager that built the dropped SDK executables.
	delete rootManifest.devDependencies?.lefthook;
	delete rootManifest.devDependencies?.['@yao-pkg/pkg'];
	writeFileSync(join(out, 'package.json'), `${JSON.stringify(rootManifest, null, 2)}\n`);

	// Dependency patches for packages nothing kept depends on any more.
	const used = new Set();
	for (const file of walk(out)) {
		if (file.endsWith(`${sep}package.json`) && !rel(file).includes('node_modules/')) {
			const manifest = readJson(file) ?? {};
			for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
				Object.keys(manifest[section] ?? {}).forEach(dep => used.add(dep));
			}
		}
	}
	const workspace = join(out, 'pnpm-workspace.yaml');
	const workspaceLines = [];
	for (const line of readFileSync(workspace, 'utf8').split('\n')) {
		const patch = /^\s+['"]?(?<pkg>@?[^@'"\s]+)@[^:'"]+['"]?:\s*(?<file>patches\/\S+)\s*$/.exec(line);
		if (patch?.groups && !used.has(patch.groups.pkg)) {
			rmSync(join(out, patch.groups.file), { force: true });
			continue;
		}
		if (/- ['"]?(website|apps\/(web|desktop|desktop-host))['"]?\s*$/.test(line)) {
			continue;
		}
		workspaceLines.push(line);
	}
	writeFileSync(workspace, workspaceLines.join('\n'));
	// The lockfile stays, so every version remains the one upstream tested; the first
	// install drops the importers and packages that went.
}

/**
 * Removes from a TypeScript project file every reference, include and path alias
 * that points at something dropped or no longer there. Rewritten as plain JSON.
 */
function pruneTsconfig(file, mentionsDropped) {
	const base = dirname(file);
	const config = parseJsonc(readFileSync(file, 'utf8'));
	if (!config) {
		fail(`Cannot parse ${rel(file)}`);
	}
	// A glob's fixed leading directories must still exist.
	const exists = entry => {
		const fixed = entry.split('/').filter((part, i, parts) => !/[*?{]/.test(parts.slice(0, i + 1).join('/'))).join('/');
		return !mentionsDropped(entry) && !DROPPED_DIR_LINE.test(`"${entry}`) && existsSync(resolve(base, fixed || '.'));
	};
	const before = JSON.stringify(config);
	if (Array.isArray(config.references)) {
		config.references = config.references.filter(ref => exists(ref.path));
	}
	for (const key of ['include', 'files', 'exclude']) {
		if (Array.isArray(config[key])) {
			config[key] = config[key].filter(exists);
		}
	}
	const paths = config.compilerOptions?.paths;
	if (paths) {
		for (const [alias, targets] of Object.entries(paths)) {
			if (mentionsDropped(alias) || !targets.some(exists)) {
				delete paths[alias];
			}
		}
	}
	if (JSON.stringify(config) !== before) {
		writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
	}
}

/** JSON with comments and trailing commas, as TypeScript project files are written. */
function parseJsonc(text) {
	let result = '';
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && (text[j] !== '"' || text[j - 1] === '\\')) {
				j++;
			}
			result += text.slice(i, j + 1);
			i = j;
		} else if (c === '/' && text[i + 1] === '/') {
			while (i < text.length && text[i] !== '\n') {
				i++;
			}
			result += '\n';
		} else if (c === '/' && text[i + 1] === '*') {
			i = text.indexOf('*/', i + 2) + 1;
		} else {
			result += c;
		}
	}
	try {
		return JSON.parse(result.replace(/,(\s*[}\]])/g, '$1'));
	} catch {
		return undefined;
	}
}

/**
 * Drops `- ...` list items (with everything indented under them) for which
 * `shouldDrop(itemText)` is true. Enough YAML for profile compositions, which
 * are lists of plugin entries.
 */
function removeYamlItems(text, shouldDrop) {
	const lines = text.split('\n');
	const result = [];
	for (let i = 0; i < lines.length;) {
		const item = /^(\s*)- /.exec(lines[i]);
		if (!item) {
			result.push(lines[i++]);
			continue;
		}
		const indent = item[1].length;
		let end = i + 1;
		while (end < lines.length && (lines[end].trim() === '' || /^\s*#/.test(lines[end]) || lines[end].search(/\S/) > indent) && !new RegExp(`^\\s{${indent}}- `).test(lines[end])) {
			end++;
		}
		const block = lines.slice(i, end);
		// Judged on its own lines only: an `- insert:` holding a whole list of plugins
		// is not dropped because one plugin in it is; its children are judged below.
		const firstNested = block.findIndex((line, n) => n > 0 && /^\s*- /.test(line) && line.search(/\S/) > indent);
		const own = firstNested < 0 ? block : block.slice(0, firstNested);
		// A dropped item takes its leading comment block with it.
		if (shouldDrop(own.join('\n'))) {
			while (result.length && /^\s*#/.test(result[result.length - 1])) {
				result.pop();
			}
		} else {
			// Nested items are pruned the same way.
			result.push(block[0]);
			if (block.length > 1) {
				result.push(...removeYamlItems(block.slice(1).join('\n'), shouldDrop).split('\n'));
			}
		}
		i = end;
	}
	return result.join('\n');
}

function rename() {
	for (const file of walk(out)) {
		const path = rel(file);
		if (path.includes('node_modules/') || path.startsWith('.git/') || isBinary(file)) {
			continue;
		}
		const text = readFileSync(file, 'utf8');
		// In the lockfile, hashes and tarball URLs are left exactly as they are.
		const next = path === 'pnpm-lock.yaml'
			? text.split('\n').map(line => /integrity:|tarball:/.test(line) ? line : applyRenames(line)).join('\n')
			: applyRenames(applyTextFixes(text));
		if (next !== text) {
			writeFileSync(file, next);
		}
	}
	// Paths last, deepest first, so parents are renamed after their children.
	for (const file of walk(out, true).reverse()) {
		const path = rel(file);
		if (path.includes('node_modules/') || path.startsWith('.git/')) {
			continue;
		}
		const name = file.slice(dirname(file).length + 1);
		const next = applyRenames(name);
		if (next !== name) {
			renameSync(file, join(dirname(file), next));
		}
	}
}

function applyRenames(text) {
	return RENAMES.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

function applyTextFixes(text) {
	return TEXT_FIXES.reduce((acc, [pattern, replacement]) => acc.replace(pattern, replacement), text);
}

function writeRootFiles() {
	const year = new Date().getUTCFullYear();
	const upstreamLicense = readFileSync(join(upstream, 'LICENSE'), 'utf8').trim();
	writeFileSync(join(out, 'LICENSE'), `MIT License

Copyright (c) ${year} HivemindIDE contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

Portions of this software are derived from third-party software under their
own licenses. See THIRD_PARTY_NOTICES.md.
`);
	writeFileSync(join(out, 'THIRD_PARTY_NOTICES.md'), `# Third-Party Notices

hivemind-agent includes software from the projects below. Each remains under
its own license; nothing here changes those terms. npm dependencies and their
licenses are recorded in \`pnpm-lock.yaml\` (\`pnpm licenses list\`), and each
directory under \`vendor/\` keeps its upstream LICENSE file.

## Agent runtime

hivemind-agent is derived from the agent runtime at
${upstreamRemote()}, used under the MIT License:

\`\`\`
${upstreamLicense}
\`\`\`
`);
	writeFileSync(join(out, 'README.md'), `# hivemind-agent

The agent shell HivemindIDE runs every hivemind node in. HivemindIDE starts it
and talks to it over the Agent Client Protocol on stdio; it has no UI of its own.

Generated by \`fork/rebrand-agent.mjs\` in the HivemindIDE repository. Do not
edit it by hand: change the script and regenerate.

\`\`\`sh
pnpm install
pnpm run build
node apps/cli/lib/bin.js --profile acp   # what HivemindIDE runs
\`\`\`

Needs Node 22.19 or newer. See LICENSE and THIRD_PARTY_NOTICES.md.
`);
}

/** Drops what went from the lockfile without changing any version that stayed. */
function pruneLockfile() {
	const env = { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: '0' };
	delete env.ELECTRON_RUN_AS_NODE;
	execFileSync('corepack', ['pnpm', 'install', '--lockfile-only', '--ignore-scripts'], { cwd: out, env, stdio: ['ignore', 'ignore', 'inherit'] });
}

function upstreamRemote() {
	try {
		return git(upstream, 'remote', 'get-url', 'origin').replace(/\.git$/, '');
	} catch {
		return 'its upstream repository';
	}
}

/** Fails listing every file that still carries the upstream brand, except the notice that must. */
function scanForTraces() {
	const hits = [];
	for (const file of walk(out, true)) {
		const path = rel(file);
		if (path.includes('node_modules/') || path.startsWith('.git/') || path === 'THIRD_PARTY_NOTICES.md') {
			continue;
		}
		if (TRACE.test(path)) {
			hits.push(`${path} (path)`);
			continue;
		}
		if (statSync(file).isFile() && !isBinary(file)) {
			readFileSync(file, 'utf8').split('\n').forEach((line, n) => {
				if (TRACE.test(line)) {
					hits.push(`${path}:${n + 1}: ${line.trim().slice(0, 140)}`);
				}
			});
		}
	}
	if (hits.length) {
		fail(`${hits.length} line(s) still carry the upstream brand:\n  ${hits.slice(0, 80).join('\n  ')}${hits.length > 80 ? `\n  … and ${hits.length - 80} more` : ''}`);
	}
	log('trace scan: clean');
}

// ---- Helpers --------------------------------------------------------------------

function walk(dir, includeDirs = false, acc = []) {
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === 'node_modules' || entry.name === '.git') {
			continue;
		}
		const path = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (includeDirs) {
				acc.push(path);
			}
			walk(path, includeDirs, acc);
		} else if (entry.isFile() || entry.isSymbolicLink()) {
			acc.push(path);
		}
	}
	return acc;
}

function isBinary(file) {
	if (lstatSync(file).isSymbolicLink()) {
		return true; // never rewritten through
	}
	const buffer = readFileSync(file);
	return buffer.subarray(0, 8000).includes(0);
}

function readJson(file) {
	try {
		return JSON.parse(readFileSync(file, 'utf8'));
	} catch {
		return undefined;
	}
}

function rel(path) {
	return relative(out, path).split(sep).join('/');
}

function git(cwd, ...args) {
	return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function escape(text) {
	return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

function log(message) {
	console.log(`[rebrand-agent] ${message}`);
}

function fail(message) {
	console.error(`[rebrand-agent] ${message}`);
	process.exit(1);
}

main();
