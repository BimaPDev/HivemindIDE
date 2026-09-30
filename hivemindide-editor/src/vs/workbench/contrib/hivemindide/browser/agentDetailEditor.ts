/*---------------------------------------------------------------------------------------------
 *  Agent review editor — opened when a graph node is clicked.
 *  Two columns: stage rail, then activity, checks, and the candidate diff.
 *--------------------------------------------------------------------------------------------*/

import './media/agentDetail.css';
import { $, append, Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { HIVEMINDIDE_DELETE_AGENT_NODE_COMMAND, HIVEMINDIDE_KILL_AGENT_NODE_COMMAND, HIVEMINDIDE_OPEN_AGENT_NODE_COMMAND, IAgentDetail } from '../common/agentTree.js';
import { AgentDetailInput, AGENT_DETAIL_EDITOR_ID } from './agentDetailInput.js';
import { AgentDetailWidget } from './agentDetailWidget.js';

export class AgentDetailEditor extends EditorPane {

	static readonly ID = AGENT_DETAIL_EDITOR_ID;

	private container: HTMLElement | undefined;
	private widget: AgentDetailWidget | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(AgentDetailEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = append(parent, $('.hivemindide-agent-detail'));
		this.widget = this._register(new AgentDetailWidget(this.container, { showBack: false, sidebar: false }));
		this._register(this.widget.onDidOpenChild(id => {
			this.commandService.executeCommand(HIVEMINDIDE_OPEN_AGENT_NODE_COMMAND, id);
		}));
		this._register(this.widget.onDidKill(() => {
			const input = this.input;
			if (!(input instanceof AgentDetailInput)) {
				return;
			}
			void this.commandService.executeCommand<IAgentDetail | undefined>(HIVEMINDIDE_KILL_AGENT_NODE_COMMAND, input.detail.nodeId).then(next => {
				if (!this.widget || !(this.input instanceof AgentDetailInput) || this.input.detail.nodeId !== input.detail.nodeId) {
					return;
				}
				if (next) {
					input.replaceDetail(next);
					this.widget.show(next);
				} else {
					this.widget.show(input.detail);
				}
			});
		}));
		this._register(this.widget.onDidDelete(() => {
			const input = this.input;
			if (!(input instanceof AgentDetailInput)) {
				return;
			}
			void this.commandService.executeCommand<boolean>(HIVEMINDIDE_DELETE_AGENT_NODE_COMMAND, input.detail.nodeId).then(deleted => {
				if (!this.widget || !(this.input instanceof AgentDetailInput) || this.input.detail.nodeId !== input.detail.nodeId) {
					return;
				}
				if (deleted) {
					void this.group.closeEditor(input);
				} else {
					this.widget.show(input.detail);
				}
			});
		}));
	}

	/** Re-render when the node's running state changes underneath an open review. */
	update(detail: IAgentDetail): void {
		if (!(this.input instanceof AgentDetailInput) || this.input.detail.nodeId !== detail.nodeId) {
			return;
		}
		this.input.replaceDetail(detail);
		this.widget?.show(detail);
	}

	override async setInput(input: AgentDetailInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		if (token.isCancellationRequested || !this.widget) {
			return;
		}
		this.widget.show(input.detail);
	}

	override clearInput(): void {
		this.widget?.hide();
		super.clearInput();
	}

	layout(dimension: Dimension): void {
		if (this.container) {
			this.container.style.height = `${dimension.height}px`;
			this.container.style.width = `${dimension.width}px`;
		}
	}
}
