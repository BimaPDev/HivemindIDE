/*---------------------------------------------------------------------------------------------
 *  Shared ids + active tab for the HivemindIDE user rail / sidebar pair.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';

export const HIVEMINDIDE_USER_VIEWLET_ID = 'workbench.view.extension.hivemindideUser';
export const HIVEMINDIDE_USER_VIEW_ID = 'workbench.view.hivemindide.user';

/** Opens the User sidebar on its Settings tab. Run by the activity bar's gear. */
export const HIVEMINDIDE_USER_OPEN_SETTINGS_COMMAND_ID = 'hivemindide.user.openSettings';

/** Opens the User sidebar on its Local AI tab. */
export const HIVEMINDIDE_USER_OPEN_LOCAL_AI_COMMAND_ID = 'hivemindide.user.openLocalAI';

/** Opens the User sidebar on its Serviced AI tab. */
export const HIVEMINDIDE_USER_OPEN_SERVICED_AI_COMMAND_ID = 'hivemindide.user.openServicedAI';

export type UserRailTab = 'settings' | 'localAI' | 'servicedAI' | 'account';

class UserRailStateImpl {
	private _tab: UserRailTab = 'settings';
	private readonly _onDidChangeTab = new Emitter<UserRailTab>();
	readonly onDidChangeTab: Event<UserRailTab> = this._onDidChangeTab.event;

	get tab(): UserRailTab {
		return this._tab;
	}

	setTab(tab: UserRailTab): void {
		this._tab = tab;
		this._onDidChangeTab.fire(tab);
	}
}

/** Singleton coordinating the outer user rail with the User sidebar content. */
export const UserRailState = new UserRailStateImpl();
