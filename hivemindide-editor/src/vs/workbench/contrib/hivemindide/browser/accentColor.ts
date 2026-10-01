/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Accent color — repaints the Hivemind Dynamic / Light chrome in the color the
 *  user picks (`hivemindide.appearance.accentColor`).
 *
 *  A window-local theme overlay, not a theme of its own: switching the accent
 *  does not change the selected theme or write `workbench.colorCustomizations`,
 *  and anything the user set there wins over the accent.
 *--------------------------------------------------------------------------------------------*/

import { Color } from '../../../../base/common/color.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ColorScheme } from '../../../../platform/theme/common/theme.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IColorCustomizations, IColorMap, IWorkbenchColorTheme, IWorkbenchThemeService, ThemeSettings } from '../../../services/themes/common/workbenchThemeService.js';
import { ACCENT_COLOR_CHOICES, ACCENT_COLOR_THEMES, AccentColorChoice, accentPalette, accentThemeColors, DEFAULT_ACCENT_COLOR } from '../common/accentColor.js';
import { HivemindIDESettings } from '../common/hivemindideConfiguration.js';

export class AccentColorContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.hivemindide.accentColor';

	private readonly overlay = this._register(new MutableDisposable());

	constructor(
		@IWorkbenchThemeService private readonly themeService: IWorkbenchThemeService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();
		this.update();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(HivemindIDESettings.AccentColor) || e.affectsConfiguration(HivemindIDESettings.CustomAccentColor)) {
				this.update();
			}
		}));
	}

	private update(): void {
		const configured = this.configurationService.getValue<string>(HivemindIDESettings.AccentColor);
		const choice = (ACCENT_COLOR_CHOICES as readonly string[]).includes(configured) ? configured as AccentColorChoice : DEFAULT_ACCENT_COLOR;
		const custom = this.configurationService.getValue<string>(HivemindIDESettings.CustomAccentColor);
		// Re-registering is what makes the theme service recompute the overlay.
		this.overlay.clear();
		this.overlay.value = this.themeService.registerColorThemeOverlay(theme => this.colorsFor(theme, choice, custom));
	}

	private colorsFor(theme: IWorkbenchColorTheme, choice: AccentColorChoice, custom: string | undefined): IColorMap {
		if (!ACCENT_COLOR_THEMES.has(theme.settingsId) || (theme.type !== ColorScheme.DARK && theme.type !== ColorScheme.LIGHT)) {
			return {};
		}
		const palette = accentPalette(choice, custom, theme.type === ColorScheme.DARK ? 'dark' : 'light');
		if (!palette) {
			return {};
		}
		const userColors = this.userColorIds(theme.settingsId);
		const colors: IColorMap = {};
		for (const [id, value] of Object.entries(accentThemeColors(palette))) {
			if (!userColors.has(id)) {
				colors[id] = Color.fromHex(value);
			}
		}
		return colors;
	}

	/** Color ids the user set in `workbench.colorCustomizations`, globally or for this theme. */
	private userColorIds(settingsId: string): Set<string> {
		const customizations = this.configurationService.getValue<IColorCustomizations>(ThemeSettings.COLOR_CUSTOMIZATIONS) ?? {};
		const ids = new Set<string>();
		for (const [key, value] of Object.entries(customizations)) {
			if (key.startsWith('[')) {
				if (key === `[${settingsId}]` && value && typeof value === 'object') {
					Object.keys(value).forEach(id => ids.add(id));
				}
			} else {
				ids.add(key);
			}
		}
		return ids;
	}
}
