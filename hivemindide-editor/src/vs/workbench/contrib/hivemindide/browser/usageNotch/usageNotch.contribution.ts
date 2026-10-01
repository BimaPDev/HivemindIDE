/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE usage notch: plan-limit rings on the window edge, and alerts as
 *  a limit nears. Gated on `hivemindide.usageNotch.enabled`; turned off, the
 *  model, notch and alerts are disposed, so no timer or listener is left.
 *
 *  Desktop only: it hears Claude Code through the hivemind shell and reads
 *  failover state, both of which the desktop entry point registers.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IInstantiationService, ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { contrastBorder } from '../../../../../platform/theme/common/colors/baseColors.js';
import { registerColor } from '../../../../../platform/theme/common/colorUtils.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { HivemindIDESettings } from '../../common/hivemindideConfiguration.js';
import { MacbookNotchBridge } from './macbookNotchBridge.js';
import { UsageAlerts } from './usageAlerts.js';
import { UsageLimitsModel } from './usageLimitsModel.js';
import { UsageNotchWidget } from './usageNotchWidget.js';

// The notch is black in every theme, as a hardware notch is; high contrast light
// inverts it and every theme gets a border in high contrast.
registerColor('hivemind.usageNotch.background', { dark: '#000000', light: '#000000', hcDark: '#000000', hcLight: '#ffffff' }, localize('hivemind.usageNotch.background', "Background of the usage notch and its cards."));
registerColor('hivemind.usageNotch.foreground', { dark: '#ffffff', light: '#ffffff', hcDark: '#ffffff', hcLight: '#000000' }, localize('hivemind.usageNotch.foreground', "Text in the usage notch and its cards."));
registerColor('hivemind.usageNotch.border', { dark: null, light: null, hcDark: contrastBorder, hcLight: contrastBorder }, localize('hivemind.usageNotch.border', "Border of the usage notch. Unset draws none."));
registerColor('hivemind.usageNotch.track', { dark: '#3a3a3a', light: '#3a3a3a', hcDark: '#6b6b6b', hcLight: '#c8c8c8' }, localize('hivemind.usageNotch.track', "Unfilled part of the usage rings and bars."));
registerColor('hivemind.usageNotch.ok', { dark: '#5fd36b', light: '#5fd36b', hcDark: '#5fd36b', hcLight: '#1b7f2e' }, localize('hivemind.usageNotch.ok', "Usage ring below half of the limit."));
registerColor('hivemind.usageNotch.elevated', { dark: '#f2e24a', light: '#f2e24a', hcDark: '#f2e24a', hcLight: '#7a6400' }, localize('hivemind.usageNotch.elevated', "Usage ring from half to 70% of the limit."));
registerColor('hivemind.usageNotch.high', { dark: '#f26b35', light: '#f26b35', hcDark: '#f26b35', hcLight: '#b3400f' }, localize('hivemind.usageNotch.high', "Usage ring from 70% to 90% of the limit."));
registerColor('hivemind.usageNotch.critical', { dark: '#ff4d4f', light: '#ff4d4f', hcDark: '#ff4d4f', hcLight: '#b5200d' }, localize('hivemind.usageNotch.critical', "Usage ring at 90% of the limit or more."));

const REFRESH_COMMAND_ID = 'hivemindide.usageNotch.refresh';
const CATEGORY = localize2('hivemindide.category', 'HivemindIDE');

/** Everything that exists while the notch is on. */
class UsageNotch extends Disposable {

	constructor(@IInstantiationService instantiationService: IInstantiationService) {
		super();
		const model = this._register(instantiationService.createInstance(UsageLimitsModel));
		const widget = this._register(instantiationService.createInstance(UsageNotchWidget, model));
		this._register(instantiationService.createInstance(UsageAlerts, model));
		// The notch at the top of the screen: the camera notch, or one drawn where there is none.
		this._register(instantiationService.createInstance(MacbookNotchBridge, model, widget));

		// Registered with the model it refreshes, and gone with it.
		this._register(CommandsRegistry.registerCommand(REFRESH_COMMAND_ID, () => model.refresh()));
		this._register(MenuRegistry.appendMenuItem(MenuId.CommandPalette, {
			command: { id: REFRESH_COMMAND_ID, title: localize2('usageNotch.refresh', 'Refresh Usage Limits'), category: CATEGORY },
		}));
	}
}

export class UsageNotchContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.hivemindide.usageNotch';

	private readonly notch = this._register(new MutableDisposable<UsageNotch>());

	constructor(
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(HivemindIDESettings.UsageNotchEnabled)) {
				this.update();
			}
		}));
		this.update();
	}

	private update(): void {
		if (!this.configurationService.getValue<boolean>(HivemindIDESettings.UsageNotchEnabled)) {
			this.notch.clear();
		} else if (!this.notch.value) {
			this.notch.value = this.instantiationService.createInstance(UsageNotch);
		}
	}
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'hivemindide.usageNotch.toggle',
			title: localize2('usageNotch.toggle', 'Toggle Usage Notch'),
			category: CATEGORY,
			f1: true,
			toggled: ContextKeyExpr.equals(`config.${HivemindIDESettings.UsageNotchEnabled}`, true),
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const configurationService = accessor.get(IConfigurationService);
		await configurationService.updateValue(HivemindIDESettings.UsageNotchEnabled, !configurationService.getValue<boolean>(HivemindIDESettings.UsageNotchEnabled), ConfigurationTarget.USER);
	}
});

// Eventually, like the status bar usage entry: nothing here may delay the first keystroke.
registerWorkbenchContribution2(UsageNotchContribution.ID, UsageNotchContribution, WorkbenchPhase.Eventually);
