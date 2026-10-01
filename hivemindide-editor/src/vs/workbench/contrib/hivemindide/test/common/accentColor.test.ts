/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Color } from '../../../../../base/common/color.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { accentPalette, accentThemeColors, parseAccentHex } from '../../common/accentColor.js';

suite('HivemindIDE accent color', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ember reproduces the colors the Hivemind Dynamic theme ships', () => {
		const colors = accentThemeColors(accentPalette('ember', undefined, 'dark')!);
		assert.deepStrictEqual({
			button: colors['button.background'],
			hover: colors['button.hoverBackground'],
			focus: colors['focusBorder'],
			link: colors['textLink.foreground'],
			selection: colors['editor.selectionBackground'],
			visor: [colors['hivemind.visorStart'], colors['hivemind.visorMid'], colors['hivemind.visorEnd']],
		}, {
			button: '#ff7a1a',
			hover: '#ff9447',
			focus: '#ff7a1a80',
			link: '#ff8f3f',
			selection: '#ff7a1a26',
			visor: ['#ff3b2f', '#ff7a1a', '#ffc53d'],
		});
	});

	test('presets have no orange left', () => {
		for (const kind of ['dark', 'light'] as const) {
			const colors = accentThemeColors(accentPalette('cobalt', undefined, kind)!);
			const orange = Object.entries(colors).filter(([, v]) => /^#(ff7a1a|ff8f3f|ff9447|f26b0f|d9540a|b8430a)/i.test(v));
			assert.deepStrictEqual(orange, [], kind);
		}
	});

	test('custom colors are parsed, and bad ones give no palette', () => {
		assert.deepStrictEqual([
			parseAccentHex('#e91e63') && Color.Format.CSS.formatHex(parseAccentHex('#e91e63')!),
			parseAccentHex(' #abc ') && Color.Format.CSS.formatHex(parseAccentHex(' #abc ')!),
			parseAccentHex('#11223380') && Color.Format.CSS.formatHex(parseAccentHex('#11223380')!),
			parseAccentHex('pink'),
			accentPalette('custom', 'nope', 'dark'),
		], ['#e91e63', '#aabbcc', '#112233', undefined, undefined]);
	});

	test('a custom color keeps text readable', () => {
		const dark = (hex: string) => accentPalette('custom', hex, 'dark')!;
		const light = (hex: string) => accentPalette('custom', hex, 'light')!;
		const contrast = (a: string, b: string) => Color.fromHex(a).getContrastRatio(Color.fromHex(b));
		assert.deepStrictEqual({
			navyButtonText: dark('#1a237e').buttonFg,
			yellowButtonText: dark('#ffeb3b').buttonFg,
			navyTextOnDark: contrast(dark('#1a237e').accentText, '#0b0b0b') >= 4.5,
			yellowTextOnWhite: contrast(light('#ffeb3b').accentText, '#ffffff') >= 4.5,
			button: dark('#e91e63').button,
		}, {
			navyButtonText: '#ffffff',
			yellowButtonText: '#0b0b0b',
			navyTextOnDark: true,
			yellowTextOnWhite: true,
			button: '#e91e63',
		});
	});
});
