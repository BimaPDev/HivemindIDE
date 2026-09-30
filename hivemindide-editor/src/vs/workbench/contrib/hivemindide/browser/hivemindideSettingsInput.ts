/*---------------------------------------------------------------------------------------------
 *  Singleton editor input for the HivemindIDE settings page (layer 1).
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

const hivemindideSettingsIcon = registerIcon(
	'hivemindide-settings-editor-label-icon',
	Codicon.settings,
	localize('hivemindideSettingsEditorLabelIcon', 'Icon of the HivemindIDE settings editor.')
);

export class HivemindIDESettingsInput extends EditorInput {

	static readonly ID = 'workbench.input.hivemindideSettings';

	readonly resource: URI = URI.from({
		scheme: Schemas.vscodeSettings,
		path: 'hivemindide-settings'
	});

	override get typeId(): string {
		return HivemindIDESettingsInput.ID;
	}

	override get editorId(): string | undefined {
		return this.typeId;
	}

	override getName(): string {
		return localize('hivemindideSettingsInputName', "HivemindIDE Settings");
	}

	override getIcon(): ThemeIcon {
		return hivemindideSettingsIcon;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		return super.matches(otherInput) || otherInput instanceof HivemindIDESettingsInput;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Singleton | EditorInputCapabilities.Readonly;
	}
}
