/*---------------------------------------------------------------------------------------------
 *  Registers the HivemindIDE Agents sidebar (author+AI spawn tree).
 *--------------------------------------------------------------------------------------------*/

import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { HIVEMINDIDE_AGENT_TREE_VIEW_ID, HIVEMINDIDE_DELETE_AGENT_NODE_COMMAND, HIVEMINDIDE_KILL_AGENT_NODE_COMMAND, HIVEMINDIDE_OPEN_AGENT_NODE_COMMAND, HIVEMINDIDE_VIEWLET_ID } from '../common/agentTree.js';
import { HivemindIDESettings } from '../common/hivemindideConfiguration.js';
import { AgentTreeViewPane } from './agentTreeViewPane.js';
import { hivemindideAgentTreeRefreshIcon, hivemindideViewIcon } from './agentTreeIcons.js';

const viewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: HIVEMINDIDE_VIEWLET_ID,
	title: localize2('hivemindide', 'HivemindIDE'),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [HIVEMINDIDE_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
	icon: hivemindideViewIcon,
	hideIfEmpty: true,
	order: 7,
	openCommandActionDescriptor: {
		id: HIVEMINDIDE_VIEWLET_ID,
		mnemonicTitle: localize({ key: 'miViewHivemindide', comment: ['&& denotes a mnemonic'] }, "&&HivemindIDE"),
		order: 7,
	},
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: HIVEMINDIDE_AGENT_TREE_VIEW_ID,
	name: localize2('hivemindide.agents', 'Agents'),
	containerIcon: hivemindideViewIcon,
	ctorDescriptor: new SyncDescriptor(AgentTreeViewPane),
	canToggleVisibility: true,
	canMoveView: true,
	when: ContextKeyExpr.equals(`config.${HivemindIDESettings.AgentTreeEnabled}`, true),
}], viewContainer);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViewWelcomeContent(HIVEMINDIDE_AGENT_TREE_VIEW_ID, {
	content: localize(
		'hivemindide.agentTree.welcome',
		"Agent spawn tree — author and parent AI share one root box; sub-agents fan out below.\n[Open Settings](command:hivemindide.action.openSettings)"
	),
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'hivemindide.agentTree.focus',
			title: localize2('hivemindide.agentTree.focus', 'Focus Agents View'),
			category: localize2('hivemindide.category', 'HivemindIDE'),
			f1: true,
			precondition: ContextKeyExpr.equals(`config.${HivemindIDESettings.AgentTreeEnabled}`, true),
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyA,
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(HIVEMINDIDE_AGENT_TREE_VIEW_ID, true);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'hivemindide.agentTree.resample',
			title: localize2('hivemindide.agentTree.resampleCmd', 'Resample Agent Tree'),
			category: localize2('hivemindide.category', 'HivemindIDE'),
			icon: hivemindideAgentTreeRefreshIcon,
			f1: true,
			precondition: ContextKeyExpr.equals(`config.${HivemindIDESettings.AgentTreeEnabled}`, true),
			menu: {
				id: MenuId.ViewTitle,
				group: 'navigation',
				when: ContextKeyExpr.equals('view', HIVEMINDIDE_AGENT_TREE_VIEW_ID),
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const views = accessor.get(IViewsService);
		let view = views.getActiveViewWithId(HIVEMINDIDE_AGENT_TREE_VIEW_ID);
		if (!(view instanceof AgentTreeViewPane)) {
			view = await views.openView(HIVEMINDIDE_AGENT_TREE_VIEW_ID, true);
		}
		if (view instanceof AgentTreeViewPane) {
			view.resample();
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: HIVEMINDIDE_OPEN_AGENT_NODE_COMMAND,
			title: localize2('hivemindide.agentTree.openNode', 'Open Agent Review'),
			category: localize2('hivemindide.category', 'HivemindIDE'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, nodeId?: string): Promise<void> {
		if (!nodeId) {
			return;
		}
		const views = accessor.get(IViewsService);
		let view = views.getActiveViewWithId(HIVEMINDIDE_AGENT_TREE_VIEW_ID);
		if (!(view instanceof AgentTreeViewPane)) {
			view = await views.openView(HIVEMINDIDE_AGENT_TREE_VIEW_ID, false);
		}
		if (view instanceof AgentTreeViewPane) {
			view.openNode(nodeId);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: HIVEMINDIDE_KILL_AGENT_NODE_COMMAND,
			title: localize2('hivemindide.agentTree.killNode', 'Kill Agent Run'),
			category: localize2('hivemindide.category', 'HivemindIDE'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, nodeId?: string) {
		if (!nodeId) {
			return undefined;
		}
		const views = accessor.get(IViewsService);
		let view = views.getActiveViewWithId(HIVEMINDIDE_AGENT_TREE_VIEW_ID);
		if (!(view instanceof AgentTreeViewPane)) {
			view = await views.openView(HIVEMINDIDE_AGENT_TREE_VIEW_ID, false);
		}
		if (view instanceof AgentTreeViewPane) {
			return view.killNode(nodeId);
		}
		return undefined;
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: HIVEMINDIDE_DELETE_AGENT_NODE_COMMAND,
			title: localize2('hivemindide.agentTree.deleteNode', 'Delete Agent Node'),
			category: localize2('hivemindide.category', 'HivemindIDE'),
			f1: false,
		});
	}

	async run(accessor: ServicesAccessor, nodeId?: string): Promise<boolean> {
		if (!nodeId) {
			return false;
		}
		const views = accessor.get(IViewsService);
		let view = views.getActiveViewWithId(HIVEMINDIDE_AGENT_TREE_VIEW_ID);
		if (!(view instanceof AgentTreeViewPane)) {
			view = await views.openView(HIVEMINDIDE_AGENT_TREE_VIEW_ID, false);
		}
		if (view instanceof AgentTreeViewPane) {
			return view.deleteNode(nodeId);
		}
		return false;
	}
});
