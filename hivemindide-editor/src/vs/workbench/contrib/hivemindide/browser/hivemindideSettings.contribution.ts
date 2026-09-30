/*---------------------------------------------------------------------------------------------
 *  Registers the HivemindIDE settings editor and steals Cmd+, / Settings menu.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { HivemindIDESettingsEditor } from './hivemindideSettingsEditor.js';
import { HivemindIDESettingsInput } from './hivemindideSettingsInput.js';

export const HIVEMINDIDE_OPEN_SETTINGS_COMMAND_ID = 'hivemindide.action.openSettings';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		HivemindIDESettingsEditor,
		HivemindIDESettingsEditor.ID,
		localize('hivemindideSettingsEditorPaneTitle', "HivemindIDE Settings")
	),
	[new SyncDescriptor(HivemindIDESettingsInput)]
);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: HIVEMINDIDE_OPEN_SETTINGS_COMMAND_ID,
			title: {
				...localize2('hivemindide.settings', "HivemindIDE Settings"),
				mnemonicTitle: localize({ key: 'miHivemindideOpenSettings', comment: ['&& denotes a mnemonic'] }, "&&Settings"),
			},
			category: Categories.Preferences,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib + 100,
				when: null,
				primary: KeyMod.CtrlCmd | KeyCode.Comma,
			},
			menu: [{
				id: MenuId.GlobalActivity,
				group: '2_configuration',
				order: 1,
			}, {
				id: MenuId.MenubarPreferencesMenu,
				group: '2_configuration',
				order: 1,
			}],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		await editorService.openEditor(new HivemindIDESettingsInput());
	}
});
