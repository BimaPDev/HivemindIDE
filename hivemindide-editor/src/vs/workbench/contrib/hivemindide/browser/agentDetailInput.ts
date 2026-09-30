/*---------------------------------------------------------------------------------------------
 *  Editor input for an agent / sub-agent detail page.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IAgentDetail } from '../common/agentTree.js';

export const AGENT_DETAIL_EDITOR_ID = 'workbench.editor.hivemindideAgentDetail';

const agentDetailIcon = registerIcon(
	'hivemindide-agent-detail-editor-label-icon',
	Codicon.organization,
	localize('hivemindideAgentDetailEditorLabelIcon', 'Icon of the HivemindIDE agent detail editor.')
);

export class AgentDetailInput extends EditorInput {

	static readonly ID = 'workbench.input.hivemindideAgentDetail';

	readonly resource: URI;

	detail: IAgentDetail;

	constructor(detail: IAgentDetail) {
		super();
		this.detail = detail;
		this.resource = URI.from({
			scheme: Schemas.vscodeSettings,
			path: `hivemindide-agent/${detail.runId}/${detail.nodeId}`,
		});
	}

	replaceDetail(detail: IAgentDetail): void {
		this.detail = detail;
	}

	override get typeId(): string {
		return AgentDetailInput.ID;
	}

	override get editorId(): string | undefined {
		return AGENT_DETAIL_EDITOR_ID;
	}

	override getName(): string {
		return this.detail.tabLabel ?? this.detail.title;
	}

	override getDescription(): string | undefined {
		return this.detail.meta.model;
	}

	override getIcon(): ThemeIcon {
		return agentDetailIcon;
	}

	override matches(otherInput: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(otherInput)) {
			return true;
		}
		return otherInput instanceof AgentDetailInput
			&& otherInput.detail.nodeId === this.detail.nodeId
			&& otherInput.detail.runId === this.detail.runId;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly;
	}
}
