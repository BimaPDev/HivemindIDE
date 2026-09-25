# Adding a native feature

The pattern every HivemindIDE feature follows, and the reasons behind each rule.
The usage indicator is the worked example — copy it.

## The shape

```
src/vs/workbench/contrib/hivemindide/
  common/
    hivemindideConfiguration.ts   all hivemindide.* settings, one file
    <feature>.ts               types, no DOM, no node
  browser/
    hivemindide.contribution.ts   the only file workbench.common.main.ts imports
    <feature>.ts               the contribution itself
```

**One line in a file upstream owns.** `workbench.common.main.ts` gets a single
import of `hivemindide.contribution.js`, and that file registers everything else.
Every other HivemindIDE file is new, so `git merge upstream/main` cannot conflict
with it. This is the single decision that determines whether living on a fork is
sustainable — a feature that edits five upstream files costs you five conflicts
every release, forever.

## 1. Declare the setting

In `common/hivemindideConfiguration.ts`, add to the existing `properties` block:

```ts
[HivemindIDESettings.MyFeatureEnabled]: {
	type: 'boolean',
	default: true,
	scope: ConfigurationScope.APPLICATION,
	description: localize('hivemindide.myFeature.enabled', "…"),
	tags: ['hivemindide']
}
```

It appears in the Settings UI automatically, grouped under **HivemindIDE**, and is
searchable by the `hivemindide` tag. No other registration is needed.

**Pick the scope deliberately.** `APPLICATION` means a workspace cannot change
it. Anything that reads your home directory, talks to a local service, or costs
money must be `APPLICATION` — otherwise a repo you clone can switch it on by
shipping a `.vscode/settings.json`. Use `WINDOW` only for genuinely per-project
preferences.

## 2. Gate the contribution on it

```ts
constructor(@IConfigurationService private readonly configurationService: IConfigurationService) {
	super();
	this._register(this.configurationService.onDidChangeConfiguration(e => {
		if (e.affectsConfiguration(HIVEMINDIDE_CONFIG_SECTION)) {
			this.update();
		}
	}));
	this.update();
}

private update(): void {
	if (!this.configurationService.getValue<boolean>(HivemindIDESettings.MyFeatureEnabled)) {
		this.disable();   // release everything
		return;
	}
	this.enable();
}
```

**Off must mean off.** `disable()` cancels timers, removes UI, drops listeners
and stops polling — it does not just hide something. A user who turns a feature
off and finds it still reading their disk every 60 seconds has been lied to.

**Re-check after every await.** The setting can flip while an async read is in
flight; the usage indicator re-reads it before touching the status bar. Without
that, turning the feature off can be immediately undone by a request that was
already running.

## 3. Register it

In `browser/hivemindide.contribution.ts`:

```ts
registerWorkbenchContribution2(MyContribution.ID, MyContribution, WorkbenchPhase.Eventually);
```

`Eventually` unless the feature is needed to edit code. `BlockStartup` and
`BlockRestore` delay the window appearing, and nothing we are building earns
that.

## 4. Build and run

```bash
cd ../hivemindide-editor && npm run compile
cd - && ./fork/run.sh
```

`npm run watch` gives an incremental rebuild if you are iterating.

## Changing an upstream default without editing upstream

For most settings, change the *default* from our own contribution rather than
editing the upstream file that declares it:

```ts
Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration)
	.registerDefaultConfigurations([{
		overrides: { 'editor.minimap.enabled': false }
	}]);
```

A user who has set the value keeps theirs, and no upstream file is touched.

### The theme is an exception — edit `ThemeSettingDefaults`

Doing the theme this way does not work, and the failure is quiet.

`ThemeSettingDefaults` in
`src/vs/workbench/services/themes/common/workbenchThemeService.ts` is not just
the default value of `workbench.colorTheme`. It also feeds:

- the welcome page's theme picker (`welcomeGettingStarted/common/media/theme_picker.ts`)
- the fallback when the current theme fails to resolve
- the pinned entries at the top of the theme quick pick
- `COLOR_THEME_DARK_INITIAL_COLORS`, the window colors painted before the theme loads

Override only the setting default and all of those keep pointing at the stock
theme. So for themes, edit `ThemeSettingDefaults` directly and accept the
conflict — it is six lines in one file, and it is the honest place for the
change.

### A default theme must also be bundled

This is the part that bites. Setting the default to a theme nobody has
installed does not error — the editor silently falls back to a stock theme, and
you are left wondering why your default "doesn't work".

Ship the theme as a built-in, in `apply-branding.sh`:

```
| .builtInExtensions = ((.builtInExtensions // []) | map(select(...)))
  + [ { "name": "Catppuccin.catppuccin-vsc", "version": "3.19.0",
        "sha256": "ebf3476648...", "repo": "...", "metadata": { ... } } ]
```

They are fetched at build time from `.extensionsGallery.serviceUrl` and the
`sha256` is verified, so a republished version fails the build loudly instead of
silently shipping different code.

Check the exact strings against the extension's own `package.json` before
trusting them — `label` for a color theme, `id` for an icon theme. They are not
the same field, and a typo in either fails silently:

```bash
unzip -p ext.vsix extension/package.json | jq '.contributes.themes[].label, .contributes.iconThemes[].id'
```

### Stub product keys, do not delete them

`product.json` keys that look like pure branding are often load-bearing.
Deleting `defaultChatAgent` produced 20 type errors, because the workbench
treats it as required in ~20 places — including `toDefaultAccountConfig`, which
reads `provider.default.id` two levels deep, where no amount of `?.` rewriting
helps.

An all-empty stub carries none of the vendor's strings and keeps every call site
type- and runtime-correct, with zero upstream files patched. Prefer it to
deleting a key and then chasing the consequences through the tree.

## Testing without the GUI

Keep the logic in plain classes that take their dependencies as **constructor
arguments rather than `@decorators`**, and you can drive the compiled output
straight from node with stubs:

```js
import { ClaudeUsageReader } from '.../out/vs/workbench/contrib/hivemindide/browser/claudeUsageService.js';
const reader = new ClaudeUsageReader(fakeFileService, fakePathService);
```

That is why `ClaudeUsageReader` is separate from `UsageIndicatorContribution`:
the contribution is the thin part that needs a running workbench, and the reader
— where the bugs live — does not.

## The feature that exists

**Usage indicator** (`hivemindide.usageIndicator.*`) — a status bar entry showing
tokens used by local AI coding tools, read from data those tools already keep on
disk. Same approach as codenotch, which is a native macOS app doing this in a
notch overlay rather than in the editor.

| Setting | Default | Does |
|---|---|---|
| `hivemindide.usageIndicator.enabled` | `true` | the toggle; off removes the entry and stops polling |
| `hivemindide.usageIndicator.dailyTokenBudget` | `0` | non-zero renders a percentage instead of a raw count |
| `hivemindide.usageIndicator.showCost` | `true` | include cost in the tooltip when reported |
| `hivemindide.usageIndicator.refreshSeconds` | `60` | poll interval, 10–3600 |

Reads `~/.claude/stats-cache.json`. Read-only, and nothing leaves the machine.

**It shows staleness rather than hiding it.** That file is written by Claude
Code on its own schedule, so there is often no entry for today. The indicator
falls back to the most recent day with data and appends `~`, and the tooltip
says which day it is showing. Rendering a stale figure as today's is the one
genuinely misleading thing an indicator like this can do.

### Adding another provider

`ClaudeUsageReader` returns `IProviderUsage[]`, and the indicator sums whatever
it gets. A Cursor or Codex reader is a new class with the same `read()` shape,
added to the snapshot — no change to the rendering code.

Note what it cannot do: local tool data reports **tokens spent, not your plan's
limit**. That is why the percentage is driven by a budget you set rather than a
limit we claim to know. Anything presented as "% of your limit" without the plan
limit in hand is a guess, and should not be labelled as though it were not.

---

## Agents sidebar (`hivemindide.agentTree.*`)

Native sidebar view: one combined root box (author who sent the command + parent
AI + model name) with graph edges and junction circles to sub-agent boxes.

| Setting | Default | Does |
|---|---|---|
| `hivemindide.agentTree.enabled` | `true` | show the HivemindIDE / Agents activity-bar view |
| `hivemindide.agentTree.coordinationUrl` | `http://127.0.0.1:8082` | coordinationd base URL |
| `hivemindide.agentTree.repoId` | seeded demo UUID | repo id for the presence / agent stream |
| `hivemindide.agentTree.demoMode` | `true` | mock tree until `agent.*` frames arrive; live frames always win |

Files live under `contrib/hivemindide/browser/agentTree*` plus
`services/hivemindide/common/coordinationClient.ts`. Open with **View → HivemindIDE**
or `HivemindIDE: Focus Agents View` (`Ctrl/Cmd+Shift+A`).

When coordinationd emits `agent.tree` / `agent.spawned` (see the services
contract), the pane switches from demo to live automatically.

**Click a node** to open the agent detail **in the same Agents sidebar**
(← Agents to go back): pipeline stepper, meta, sub-agent activity, checks, and
candidate diff — no editor tab.
