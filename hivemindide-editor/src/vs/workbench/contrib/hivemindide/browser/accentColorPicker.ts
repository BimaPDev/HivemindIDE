/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Accent swatches for the HivemindIDE settings surfaces: one per lens, plus a
 *  Custom swatch that opens the system color picker.
 *--------------------------------------------------------------------------------------------*/

import './media/accentColorPicker.css';
import { $, addDisposableListener, append, EventType } from '../../../../base/browser/dom.js';
import { Color } from '../../../../base/common/color.js';
import { DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ACCENT_COLOR_CHOICES, AccentColorChoice, accentPalette, DEFAULT_ACCENT_COLOR, DEFAULT_CUSTOM_ACCENT_COLOR, parseAccentHex } from '../common/accentColor.js';
import { HivemindIDESettings } from '../common/hivemindideConfiguration.js';

const LABELS: Record<AccentColorChoice, string> = {
	ember: localize('hivemindide.accentPicker.ember', "Ember"),
	jade: localize('hivemindide.accentPicker.jade', "Jade"),
	cobalt: localize('hivemindide.accentPicker.cobalt', "Cobalt"),
	violet: localize('hivemindide.accentPicker.violet', "Violet"),
	chrome: localize('hivemindide.accentPicker.chrome', "Chrome"),
	custom: localize('hivemindide.accentPicker.custom', "Custom"),
};

function swatchBackground(stops: readonly string[]): string {
	return `linear-gradient(135deg, ${stops.join(', ')})`;
}

/** Renders the swatches into `parent`; writes the accent settings when one is picked. */
export function renderAccentColorPicker(parent: HTMLElement, configurationService: IConfigurationService): IDisposable {
	const store = new DisposableStore();
	const configured = configurationService.getValue<string>(HivemindIDESettings.AccentColor);
	const current = (ACCENT_COLOR_CHOICES as readonly string[]).includes(configured) ? configured as AccentColorChoice : DEFAULT_ACCENT_COLOR;
	const customHex = Color.Format.CSS.formatHex(parseAccentHex(configurationService.getValue<string>(HivemindIDESettings.CustomAccentColor)) ?? Color.fromHex(DEFAULT_CUSTOM_ACCENT_COLOR));

	const group = append(parent, $('.hivemindide-accent-picker'));
	group.setAttribute('role', 'radiogroup');
	group.setAttribute('aria-label', localize('hivemindide.accentPicker.aria', "Accent color"));

	const pick = (choice: AccentColorChoice) => {
		configurationService.updateValue(HivemindIDESettings.AccentColor, choice);
	};

	for (const choice of ACCENT_COLOR_CHOICES) {
		const swatch = append(group, $('button.hivemindide-accent-swatch')) as HTMLButtonElement;
		swatch.type = 'button';
		swatch.setAttribute('role', 'radio');
		swatch.setAttribute('aria-checked', String(choice === current));
		swatch.setAttribute('aria-label', LABELS[choice]);
		swatch.classList.toggle('checked', choice === current);
		const chip = append(swatch, $('span.hivemindide-accent-swatch-chip'));
		append(swatch, $('span.hivemindide-accent-swatch-label')).textContent = LABELS[choice];

		if (choice !== 'custom') {
			chip.style.background = swatchBackground(accentPalette(choice, undefined, 'dark')!.visor);
			store.add(addDisposableListener(swatch, EventType.CLICK, () => pick(choice)));
			continue;
		}

		// Custom: the chip is the system color picker. `input` only previews; the
		// setting is written on `change` (picker closed), because writing it
		// re-renders this page and would close the picker mid-drag.
		chip.style.background = customHex;
		const input = append(chip, $('input.hivemindide-accent-swatch-input')) as HTMLInputElement;
		input.type = 'color';
		input.value = customHex;
		input.tabIndex = -1;
		input.setAttribute('aria-hidden', 'true');
		store.add(addDisposableListener(swatch, EventType.CLICK, e => {
			if (e.target !== input) {
				input.click();
			}
		}));
		store.add(addDisposableListener(input, 'input', () => {
			chip.style.background = input.value;
		}));
		store.add(addDisposableListener(input, EventType.CHANGE, async () => {
			await configurationService.updateValue(HivemindIDESettings.CustomAccentColor, input.value);
			pick('custom');
		}));
	}

	store.add({ dispose: () => group.remove() });
	return store;
}
