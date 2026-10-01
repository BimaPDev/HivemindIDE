---
id: 20261001-0540-accent-color-setting-c4lb
title: Accent color setting (default UI no longer orange)
status: done
author: Niraj Dhakal
agent: Claude Code
model: claude-opus-5-5
created: 2026-10-01T05:40:00Z
updated: 2026-10-01T05:40:00Z
---

## Goal
The UI chrome was bright orange (the Ember lens `#ff7a1a` baked into Hivemind Dynamic / Light). Change it, and add a setting to pick any color.

## Handoff
Done and verified in a running demo instance, uncommitted. New setting `hivemindide.appearance.accentColor` (ember | jade | cobalt | violet | chrome | custom, default **cobalt**) plus `hivemindide.appearance.customAccentColor` (hex, used for `custom`). Swatch picker in the "Appearance" section of both HivemindIDE settings surfaces; Custom opens the system color picker.
Possible next steps: hide the swatches (or explain) when a single-lens theme is active, since the setting does nothing there; regenerate the onboarding theme previews (their SVGs 404).

## Files
- hivemindide-editor/src/vs/workbench/contrib/hivemindide/common/accentColor.ts
- hivemindide-editor/src/vs/workbench/contrib/hivemindide/browser/accentColor.ts
- hivemindide-editor/src/vs/workbench/contrib/hivemindide/browser/accentColorPicker.ts
- hivemindide-editor/src/vs/workbench/contrib/hivemindide/browser/media/accentColorPicker.css
- hivemindide-editor/src/vs/workbench/contrib/hivemindide/test/common/accentColor.test.ts
- hivemindide-editor/src/vs/workbench/contrib/hivemindide/common/hivemindideConfiguration.ts
- hivemindide-editor/src/vs/workbench/contrib/hivemindide/browser/hivemindide.contribution.ts
- hivemindide-editor/src/vs/workbench/contrib/hivemindide/browser/hivemindideSettingsEditor.ts
- hivemindide-editor/src/vs/workbench/contrib/hivemindide/browser/userSidebarViewPane.ts
- hivemindide-editor/extensions/theme-hivemind/build/generate-themes.py (comment only)

## Log
### 2026-10-01 05:40 · Niraj Dhakal
Asked: the UI is bright orange; change it and make the colors a setting.
- Mechanism: a window-local overlay via `IWorkbenchThemeService.registerColorThemeOverlay` (AccentColorContribution, BlockStartup). It does not change the theme or write `workbench.colorCustomizations`; colors the user set there (globally or under `[Hivemind Dynamic]`) still win.
- Scope: only Hivemind Dynamic and Hivemind Light. The single-lens themes (Ember, Jade, Cobalt, Violet, Chrome) keep their own lens: picking "Hivemind Ember" is an explicit choice of orange. HC themes are untouched.
- `common/accentColor.ts`: dark and light palettes per lens (light uses deep tones for strokes and text), and for a custom hex it derives hover, text (≥4.5:1 on the background), selection alphas and the visor gradient, with black or white button text, whichever contrasts more. The key → role/alpha table mirrors generate-themes.py `colors()`; checked that `ember` reproduces both theme files exactly (only `charts.orange` is left, on purpose). `hivemind.beam1` follows the accent; beams 2–5 keep the multi-lens cycle.
- Verified in a demo instance via CDP: default cobalt (button `#3d9bff`), live switch to custom `#e91e63`, clicking the Violet swatch writes the setting and repaints, Light theme gets `#a679ff` / `#6a2fb0`, and a user `button.background` customization wins. 5 unit tests pass; typecheck-client clean.
- Gotcha: the first-run onboarding's theme step wrote `"workbench.colorTheme": "Hivemind Ember"` to the demo profile, so that window stayed orange (by design, see Scope). Users who picked Ember in onboarding will still see orange.
- Known: before the overlay applies, the theme cached from the last session paints for a moment (overlay colors are not stored with the theme), so a brief flash of the theme's own accent is possible on a cold start.
