/*---------------------------------------------------------------------------------------------
 *  Registers the agent detail editor pane (opened from the Agents tree).
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorExtensions } from '../../../common/editor.js';
import { AgentDetailEditor } from './agentDetailEditor.js';
import { AgentDetailInput } from './agentDetailInput.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		AgentDetailEditor,
		AgentDetailEditor.ID,
		localize('hivemindideAgentDetailEditorPaneTitle', "Agent")
	),
	[new SyncDescriptor(AgentDetailInput)]
);
