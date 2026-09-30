/*---------------------------------------------------------------------------------------------
 *  Registers the HivemindIDE User sidebar (icon rail + content inside the sidebar).
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { HIVEMINDIDE_USER_OPEN_LOCAL_AI_COMMAND_ID, HIVEMINDIDE_USER_OPEN_SERVICED_AI_COMMAND_ID, HIVEMINDIDE_USER_OPEN_SETTINGS_COMMAND_ID, HIVEMINDIDE_USER_VIEW_ID, HIVEMINDIDE_USER_VIEWLET_ID, UserRailState } from '../common/userSidebar.js';
import { hivemindideUserViewIcon } from './userSidebarIcons.js';
import { UserSidebarViewPane } from './userSidebarViewPane.js';

const viewContainer = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry).registerViewContainer({
	id: HIVEMINDIDE_USER_VIEWLET_ID,
	title: localize2('hivemindide.user', 'User'),
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [HIVEMINDIDE_USER_VIEWLET_ID, { mergeViewWithContainerWhenSingleView: true }]),
	icon: hivemindideUserViewIcon,
	hideIfEmpty: false,
	// Opened from the Manage gear, so it gets no activity bar icon or View menu entry.
	hideFromActivityBar: true,
	order: 98,
}, ViewContainerLocation.Sidebar);

Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry).registerViews([{
	id: HIVEMINDIDE_USER_VIEW_ID,
	name: localize2('hivemindide.user.view', 'User'),
	containerIcon: hivemindideUserViewIcon,
	ctorDescriptor: new SyncDescriptor(UserSidebarViewPane),
	canToggleVisibility: false,
	canMoveView: true,
}], viewContainer);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'hivemindide.user.focus',
			title: localize2('hivemindide.user.focus', 'Focus User View'),
			category: localize2('hivemindide.category', 'HivemindIDE'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(IViewsService).openView(HIVEMINDIDE_USER_VIEW_ID, true);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: HIVEMINDIDE_USER_OPEN_SETTINGS_COMMAND_ID,
			title: localize2('hivemindide.user.openSettings', 'Open HivemindIDE Settings Sidebar'),
			category: localize2('hivemindide.category', 'HivemindIDE'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const viewsService = accessor.get(IViewsService);
		// The panel has no activity bar icon, so the gear doubles as its close button.
		if (viewsService.isViewVisible(HIVEMINDIDE_USER_VIEW_ID) && UserRailState.tab === 'settings') {
			viewsService.closeView(HIVEMINDIDE_USER_VIEW_ID);
			return;
		}
		UserRailState.setTab('settings');
		await viewsService.openView(HIVEMINDIDE_USER_VIEW_ID, true);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: HIVEMINDIDE_USER_OPEN_LOCAL_AI_COMMAND_ID,
			title: localize2('hivemindide.user.openLocalAI', 'Open Local AI Settings'),
			category: localize2('hivemindide.category', 'HivemindIDE'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		UserRailState.setTab('localAI');
		await accessor.get(IViewsService).openView(HIVEMINDIDE_USER_VIEW_ID, true);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: HIVEMINDIDE_USER_OPEN_SERVICED_AI_COMMAND_ID,
			title: localize2('hivemindide.user.openServicedAI', 'Open Serviced AI Settings'),
			category: localize2('hivemindide.category', 'HivemindIDE'),
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		UserRailState.setTab('servicedAI');
		await accessor.get(IViewsService).openView(HIVEMINDIDE_USER_VIEW_ID, true);
	}
});
