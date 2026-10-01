/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Accent color of the Hivemind Dynamic and Hivemind Light themes.
 *
 *  Both themes paint the workbench chrome (buttons, badges, the active tab,
 *  focus rings, the cursor, the visor gradient) in one accent, which the theme
 *  files fix to the Ember lens. This module turns the user's choice, a lens or
 *  any hex color, into the theme colors that carry that accent, so a runtime
 *  overlay can repaint them. The roles and alphas mirror
 *  extensions/theme-hivemind/build/generate-themes.py: keep them in step.
 *--------------------------------------------------------------------------------------------*/

import { Color, HSLA, RGBA } from '../../../../base/common/color.js';

export type AccentColorChoice = 'ember' | 'jade' | 'cobalt' | 'violet' | 'chrome' | 'custom';

export const ACCENT_COLOR_CHOICES: readonly AccentColorChoice[] = ['ember', 'jade', 'cobalt', 'violet', 'chrome', 'custom'];

export const DEFAULT_ACCENT_COLOR: AccentColorChoice = 'cobalt';

export const DEFAULT_CUSTOM_ACCENT_COLOR = '#3d9bff';

/** The themes whose chrome follows the accent setting. The single-lens themes keep their own lens. */
export const ACCENT_COLOR_THEMES: ReadonlySet<string> = new Set(['Hivemind Dynamic', 'Hivemind Light']);

/** Every color a theme derives from its accent. Hex strings; alpha is applied per key. */
export interface IAccentPalette {
	/** Strokes: borders, the cursor, the active tab and panel indicators. */
	readonly accent: string;
	/** Text drawn in the accent: links, match highlights. Must read on the editor background. */
	readonly accentText: string;
	/** Filled surfaces: primary buttons, badges. */
	readonly button: string;
	readonly buttonHover: string;
	/** Text on a `button` surface. */
	readonly buttonFg: string;
	readonly selection: string;
	readonly findMatch: string;
	readonly findMatchHighlight: string;
	/** The visor gradient stops, dark to light. */
	readonly visor: readonly [string, string, string];
}

type ThemeKind = 'dark' | 'light';

const ON_ACCENT = '#0b0b0b';

/** Dark presets: the lens palettes from generate-themes.py. */
const DARK_PRESETS: Record<Exclude<AccentColorChoice, 'custom'>, IAccentPalette> = {
	ember: {
		accent: '#ff7a1a', accentText: '#ff8f3f', button: '#ff7a1a', buttonHover: '#ff9447', buttonFg: ON_ACCENT,
		selection: '#ff7a1a26', findMatch: '#ff7a1a55', findMatchHighlight: '#ff7a1a22',
		visor: ['#ff3b2f', '#ff7a1a', '#ffc53d'],
	},
	jade: {
		accent: '#b8ff3c', accentText: '#b8ff3c', button: '#b8ff3c', buttonHover: '#c9ff66', buttonFg: ON_ACCENT,
		selection: '#b8ff3c24', findMatch: '#b8ff3c55', findMatchHighlight: '#b8ff3c22',
		visor: ['#2ee6a6', '#b8ff3c', '#f2ee4f'],
	},
	cobalt: {
		accent: '#3d9bff', accentText: '#5aabff', button: '#3d9bff', buttonHover: '#63b0ff', buttonFg: ON_ACCENT,
		selection: '#3d9bff26', findMatch: '#3d9bff55', findMatchHighlight: '#3d9bff22',
		visor: ['#2b6bff', '#3d9bff', '#8fd8ff'],
	},
	violet: {
		accent: '#a86bff', accentText: '#b98aff', button: '#a86bff', buttonHover: '#bb8cff', buttonFg: ON_ACCENT,
		selection: '#a86bff26', findMatch: '#a86bff55', findMatchHighlight: '#a86bff22',
		visor: ['#7b3cff', '#a86bff', '#e0a8ff'],
	},
	chrome: {
		accent: '#e6e6e6', accentText: '#ffffff', button: '#e6e6e6', buttonHover: '#ffffff', buttonFg: ON_ACCENT,
		selection: '#ffffff1f', findMatch: '#ffffff40', findMatchHighlight: '#ffffff1a',
		visor: ['#6e6e6e', '#d9d9d9', '#ffffff'],
	},
};

/** Light presets: the same lenses in deep tones that hold contrast on white; buttons stay bright under black text. */
const LIGHT_PRESETS: Record<Exclude<AccentColorChoice, 'custom'>, IAccentPalette> = {
	ember: {
		accent: '#d9540a', accentText: '#b8430a', button: '#f26b0f', buttonHover: '#f5802f', buttonFg: ON_ACCENT,
		selection: '#f26b0f24', findMatch: '#f26b0f4d', findMatchHighlight: '#f26b0f1f',
		visor: ['#e0341f', '#f26b0f', '#f2a900'],
	},
	jade: {
		accent: '#3a8a00', accentText: '#2f7000', button: '#8fd400', buttonHover: '#a0de2a', buttonFg: ON_ACCENT,
		selection: '#8fd40030', findMatch: '#8fd40066', findMatchHighlight: '#8fd40029',
		visor: ['#0f9a70', '#6cbf00', '#c8c800'],
	},
	cobalt: {
		accent: '#1f5fd6', accentText: '#1a4fb8', button: '#4d94ff', buttonHover: '#69a6ff', buttonFg: ON_ACCENT,
		selection: '#4d94ff24', findMatch: '#4d94ff4d', findMatchHighlight: '#4d94ff1f',
		visor: ['#1f5fd6', '#3d8bff', '#5cc4f5'],
	},
	violet: {
		accent: '#7b3cc8', accentText: '#6a2fb0', button: '#a679ff', buttonHover: '#b690ff', buttonFg: ON_ACCENT,
		selection: '#a679ff24', findMatch: '#a679ff4d', findMatchHighlight: '#a679ff1f',
		visor: ['#6a2fe0', '#9a5cff', '#d08cf0'],
	},
	chrome: {
		accent: '#4a4a4a', accentText: '#262626', button: '#cfcfcb', buttonHover: '#dcdcd8', buttonFg: ON_ACCENT,
		selection: '#0000001a', findMatch: '#00000033', findMatchHighlight: '#00000014',
		visor: ['#3a3a3a', '#8a8a8a', '#c8c8c8'],
	},
};

/** The background accent text must read on, per theme kind (the editor background of each theme). */
const BACKGROUND: Record<ThemeKind, string> = { dark: '#0b0b0b', light: '#ffffff' };

function hex(color: Color): string {
	return Color.Format.CSS.formatHex(color);
}

function shiftHue(color: Color, degrees: number, lightness: number): Color {
	const { h, s, l } = color.hsla;
	return new Color(new HSLA((h + degrees + 360) % 360, s, Math.max(0, Math.min(1, l + lightness)), 1));
}

/** Parses `#rgb`, `#rrggbb` or `#rrggbbaa` (alpha dropped). Undefined when it is not a color. */
export function parseAccentHex(value: string | undefined): Color | undefined {
	const parsed = typeof value === 'string' ? Color.Format.CSS.parseHex(value.trim()) : null;
	if (!parsed) {
		return undefined;
	}
	const { r, g, b } = parsed.rgba;
	return new Color(new RGBA(r, g, b, 1));
}

/** A palette built around one color, the way the presets are built around their lens. */
function derivePalette(base: Color, kind: ThemeKind): IAccentPalette {
	const background = Color.fromHex(BACKGROUND[kind]);
	const black = Color.fromHex(ON_ACCENT);
	const white = Color.white;
	const buttonFg = black.getContrastRatio(base) >= white.getContrastRatio(base) ? black : white;
	const accent = kind === 'dark' ? base : background.ensureConstrast(base, 3);
	const accentText = background.ensureConstrast(kind === 'dark' ? base.lighten(0.1) : base, 4.5);
	const buttonHover = kind === 'dark' || base.isDarker() ? base.lighten(0.15) : base.darken(0.08);
	const [selection, findMatch, findMatchHighlight] = kind === 'dark' ? ['26', '55', '22'] : ['24', '4d', '1f'];
	return {
		accent: hex(accent),
		accentText: hex(accentText),
		button: hex(base),
		buttonHover: hex(buttonHover),
		buttonFg: hex(buttonFg),
		selection: hex(base) + selection,
		findMatch: hex(base) + findMatch,
		findMatchHighlight: hex(base) + findMatchHighlight,
		visor: [hex(shiftHue(base, -20, -0.08)), hex(base), hex(shiftHue(base, 25, 0.12))],
	};
}

/** The palette for a choice, or undefined when a custom color does not parse. */
export function accentPalette(choice: AccentColorChoice, customHex: string | undefined, kind: ThemeKind): IAccentPalette | undefined {
	if (choice === 'custom') {
		const base = parseAccentHex(customHex);
		return base ? derivePalette(base, kind) : undefined;
	}
	return (kind === 'dark' ? DARK_PRESETS : LIGHT_PRESETS)[choice];
}

/** The theme color ids each palette role carries, with the alpha the theme files give them. */
const ROLES: readonly (readonly [keyof Omit<IAccentPalette, 'visor'>, string, readonly string[]])[] = [
	['accent', '', [
		'sash.hoverBorder', 'progressBar.background', 'activityBar.activeBorder', 'activityBar.activeFocusBorder',
		'activityBarTop.activeBorder', 'tab.activeBorderTop', 'tab.selectedBorderTop', 'editorCursor.foreground',
		'editor.findMatchBorder', 'panelTitle.activeBorder', 'terminal.tab.activeBorder', 'terminalCursor.foreground',
		'statusBar.focusBorder', 'statusBarItem.focusBorder', 'settings.modifiedItemIndicator', 'welcomePage.progress.foreground',
		'charts.green',
	]],
	['accent', '80', ['focusBorder', 'inputOption.activeBorder', 'editorBracketMatch.border', 'peekView.border', 'interactive.activeCodeBorder']],
	['accent', '22', ['inputOption.activeBackground', 'chat.slashCommandBackground']],
	['accent', '66', ['list.focusOutline', 'list.focusAndSelectionOutline']],
	['accent', '1a', ['list.dropBackground', 'editorBracketMatch.background']],
	['accent', '14', ['editorGroup.dropBackground']],
	['accent', '99', ['editorOverviewRuler.findMatchForeground']],
	['accentText', '', [
		'textLink.foreground', 'textLink.activeForeground', 'checkbox.foreground', 'list.highlightForeground',
		'list.focusHighlightForeground', 'editorLink.activeForeground', 'editorSuggestWidget.highlightForeground',
		'editorSuggestWidget.focusHighlightForeground', 'statusBarItem.remoteForeground', 'quickInputList.focusHighlightForeground',
		'pickerGroup.foreground', 'notificationLink.foreground', 'chat.slashCommandForeground', 'ports.iconRunningProcessForeground',
	]],
	['button', '', ['button.background', 'extensionButton.prominentBackground', 'badge.background', 'activityBarBadge.background', 'statusBar.debuggingBackground']],
	['buttonHover', '', ['button.hoverBackground', 'extensionButton.prominentHoverBackground']],
	['buttonFg', '', ['button.foreground', 'extensionButton.prominentForeground', 'badge.foreground', 'activityBarBadge.foreground', 'statusBar.debuggingForeground']],
	['buttonFg', '40', ['button.separator']],
	['selection', '', ['selection.background', 'editor.selectionBackground', 'editorCommentsWidget.rangeActiveBackground', 'terminal.selectionBackground']],
	['findMatch', '', ['editor.findMatchBackground', 'peekViewEditor.matchHighlightBackground', 'peekViewResult.matchHighlightBackground']],
	['findMatchHighlight', '', ['editor.findMatchHighlightBackground']],
];

/** Theme color id → hex color for every color the accent carries. */
export function accentThemeColors(palette: IAccentPalette): Record<string, string> {
	const colors: Record<string, string> = {};
	for (const [role, alpha, ids] of ROLES) {
		for (const id of ids) {
			colors[id] = palette[role] + alpha;
		}
	}
	colors['hivemind.visorStart'] = palette.visor[0];
	colors['hivemind.visorMid'] = palette.visor[1];
	colors['hivemind.visorEnd'] = palette.visor[2];
	// The chat working beam starts each cycle in the accent; the other lenses follow.
	colors['hivemind.beam1'] = palette.visor[1];
	return colors;
}
