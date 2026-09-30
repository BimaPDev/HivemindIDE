/*---------------------------------------------------------------------------------------------
 *  HivemindIDE: keep GitHub Copilot chrome out of the workbench.
 *
 *  product.json ships an empty defaultChatAgent stub (required by ~20 call sites).
 *  ChatEntitlementService treats a missing chatExtensionId as "hide setup", but the
 *  Copilot status-bar entry can still paint from persisted chat.setupContext. Force
 *  the sentiment.hidden context key on every startup so status bar, welcome steps,
 *  and accounts menus stay gone.
 *--------------------------------------------------------------------------------------------*/

import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IChatEntitlementService } from '../../../services/chat/common/chatEntitlementService.js';

export class HideCopilotContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.hivemindide.hideCopilot';

	constructor(
		@IChatEntitlementService chatEntitlementService: IChatEntitlementService,
	) {
		chatEntitlementService.setForceHidden(true);
	}
}
