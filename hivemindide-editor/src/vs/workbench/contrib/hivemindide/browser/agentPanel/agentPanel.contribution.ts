/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE Agent panel: the chat lives in the bottom panel as the first tab,
 *  "Agent", beside Terminal and Problems. The chat moves there once per profile;
 *  after that it stays wherever the user drags it.
 *
 *  The panel's tabs get an icon before each label and a "Live" pill on Agent
 *  while a chat request runs (styles in media/agentPanel.css).
 *--------------------------------------------------------------------------------------------*/

import './media/agentPanel.css';
import { $ } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Disposable, MutableDisposable, toDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../../nls.js';
import { SyncDescriptor } from '../../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { registerIcon } from '../../../../../platform/theme/common/iconRegistry.js';
import { ViewPaneContainer } from '../../../../browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, ViewContainer, ViewContainerLocation } from '../../../../common/views.js';
import { IWorkbenchLayoutService, Parts } from '../../../../services/layout/browser/layoutService.js';
import { ILifecycleService, LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { IPaneCompositePartService } from '../../../../services/panecomposite/browser/panecomposite.js';
import { IViewsService } from '../../../../services/views/common/viewsService.js';
import { ChatViewContainerId, ChatViewId } from '../../../chat/browser/chat.js';
import { IChatService } from '../../../chat/common/chatService/chatService.js';

const AGENT_PANEL_ID = 'workbench.panel.hivemindide.agent';

/** Set once the chat has been moved into the Agent panel, so a later move by the user sticks. */
const CHAT_MOVED_KEY = 'hivemindide.agentPanel.chatMoved';

const agentPanelIcon = registerIcon('hivemindide-agent-panel-icon', Codicon.robot, localize('hivemindide.agentPanel.icon', "Icon of the Agent panel."));

const agentPanel: ViewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: AGENT_PANEL_ID,
	title: localize2('hivemindide.agentPanel', "Agent"),
	icon: agentPanelIcon,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [AGENT_PANEL_ID, { mergeViewWithContainerWhenSingleView: true }]),
	storageId: AGENT_PANEL_ID,
	hideIfEmpty: true,
	// Before Problems (0), so Agent is the first tab.
	order: -1,
	// "Agent" and the robot, not the moved view's own "Chat".
	alwaysUseContainerInfo: true,
}, ViewContainerLocation.Panel);

/**
 * Moves the chat into the Agent panel the first time this profile starts, and never
 * leaves the secondary side bar open on the chat's old container once it is empty.
 */
class AgentPanelPlacement extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.hivemindide.agentPanelPlacement';

	constructor(
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IStorageService storageService: IStorageService,
		@IViewsService private readonly viewsService: IViewsService,
		@ILifecycleService lifecycleService: ILifecycleService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
	) {
		super();
		let moved = false;
		const chatView = viewDescriptorService.getViewDescriptorById(ChatViewId);
		if (chatView && !storageService.getBoolean(CHAT_MOVED_KEY, StorageScope.PROFILE, false)) {
			if (viewDescriptorService.getViewContainerByViewId(ChatViewId) !== agentPanel) {
				viewDescriptorService.moveViewsToContainer([chatView], agentPanel, undefined, 'hivemindide.agentPanel');
			}
			storageService.store(CHAT_MOVED_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
			moved = true;
		}
		lifecycleService.when(LifecyclePhase.Restored).then(() => this.closeEmptyChatSideBar(moved));
	}

	/** The side bar restores the chat's old container even when nothing is left in it. */
	private closeEmptyChatSideBar(showAgentPanel: boolean): void {
		const chatContainer = this.viewDescriptorService.getViewContainerById(ChatViewContainerId);
		const open = this.paneCompositeService.getActivePaneComposite(ViewContainerLocation.AuxiliaryBar);
		if (chatContainer && open?.getId() === ChatViewContainerId && this.viewDescriptorService.getViewContainerModel(chatContainer).visibleViewDescriptors.length === 0) {
			this.layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			showAgentPanel = this.viewDescriptorService.getViewContainerByViewId(ChatViewId) === agentPanel;
		}
		if (showAgentPanel) {
			this.showAgentPanel();
		}
	}

	/** The chat view only becomes active once chat has finished setting up, often after restore. */
	private showAgentPanel(): void {
		const model = this.viewDescriptorService.getViewContainerModel(agentPanel);
		if (model.activeViewDescriptors.some(v => v.id === ChatViewId)) {
			this.viewsService.openView(ChatViewId, false);
			return;
		}
		const listener = this._register(new MutableDisposable());
		listener.value = model.onDidChangeActiveViewDescriptors(({ added }) => {
			if (added.some(v => v.id === ChatViewId)) {
				listener.clear();
				this.viewsService.openView(ChatViewId, false);
			}
		});
	}
}

/** Draws an icon before each panel tab's label, and "Live" on Agent while a chat request runs. */
class AgentPanelTabs extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.hivemindide.agentPanelTabs';

	private live = false;

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IViewDescriptorService private readonly viewDescriptorService: IViewDescriptorService,
		@IChatService chatService: IChatService,
	) {
		super();
		const panel = layoutService.getContainer(mainWindow, Parts.PANEL_PART);
		if (!panel) {
			return;
		}
		// The composite bar re-renders its tabs on pin, move and overflow changes.
		const observer = new MutationObserver(() => this.decorate(panel));
		observer.observe(panel, { childList: true, subtree: true });
		this._register(toDisposable(() => observer.disconnect()));
		this._register(autorun(reader => {
			this.live = chatService.requestInProgressObs.read(reader);
			this.decorate(panel);
		}));
	}

	private decorate(panel: HTMLElement): void {
		for (const tab of panel.querySelectorAll<HTMLElement>('.title .composite-bar .action-item[data-composite-id]')) {
			const id = tab.dataset.compositeId!;
			if (!tab.classList.contains('icon') && !tab.querySelector(':scope > .hivemind-tab-icon')) {
				const container = this.viewDescriptorService.getViewContainerById(id);
				const icon = container && this.viewDescriptorService.getViewContainerModel(container).icon;
				if (ThemeIcon.isThemeIcon(icon)) {
					tab.prepend($(`span.hivemind-tab-icon${ThemeIcon.asCSSSelector(icon)}`, { 'aria-hidden': 'true' }));
				}
			}
			if (id === AGENT_PANEL_ID) {
				let pill = tab.querySelector<HTMLElement>(':scope > .hivemind-tab-live');
				if (!pill) {
					pill = $('span.hivemind-tab-live', { 'aria-hidden': 'true' }, localize('hivemindide.agentPanel.live', "Live"));
					tab.querySelector(':scope > .action-label')?.after(pill);
				}
				pill.hidden = !this.live;
			}
		}
	}
}

registerWorkbenchContribution2(AgentPanelPlacement.ID, AgentPanelPlacement, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(AgentPanelTabs.ID, AgentPanelTabs, WorkbenchPhase.AfterRestored);
