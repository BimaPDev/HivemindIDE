/*---------------------------------------------------------------------------------------------
 *  HivemindIDE hivemind: registration and commands.
 *--------------------------------------------------------------------------------------------*/

import { fromNow } from '../../../../../base/common/date.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { HivemindService, IHivemindNode, IHivemindService } from './hivemindService.js';

registerSingleton(IHivemindService, HivemindService, InstantiationType.Delayed);

/** Creates the service at startup, so every trusted project gets its `.hivemind` without anyone asking. */
class HivemindStartupContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.hivemindide.hivemind';
	constructor(@IHivemindService _hivemindService: IHivemindService) { }
}
registerWorkbenchContribution2(HivemindStartupContribution.ID, HivemindStartupContribution, WorkbenchPhase.Eventually);

export const HIVEMIND_CONTINUE_COMMAND_ID = 'hivemindide.hivemind.continueNode';
const CATEGORY = localize2('hivemindide.hivemind.category', "HivemindIDE Hivemind");

export interface IHivemindNodePick extends IQuickPickItem {
	readonly node: IHivemindNode;
}

export function hivemindNodePicks(nodes: readonly IHivemindNode[]): IHivemindNodePick[] {
	return nodes.map(node => ({
		label: node.title,
		description: `${node.status} · ${node.author} · ${node.agent}`,
		detail: node.updated ? localize('hivemind.pick.updated', "updated {0}", fromNow(new Date(node.updated), true)) : undefined,
		node,
	}));
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: HIVEMIND_CONTINUE_COMMAND_ID, title: localize2('hivemind.continue', "Continue a Hivemind Node…"), category: CATEGORY, f1: true });
	}

	async run(accessor: ServicesAccessor, nodeId?: string): Promise<void> {
		const hivemindService = accessor.get(IHivemindService);
		const quickInputService = accessor.get(IQuickInputService);
		const commandService = accessor.get(ICommandService);
		const notificationService = accessor.get(INotificationService);

		let id = nodeId;
		if (!id) {
			if (hivemindService.nodes.length === 0) {
				notificationService.info(localize('hivemind.continue.none', "This project's hivemind has no nodes yet. They appear as you and other AIs work here."));
				return;
			}
			const pick = await quickInputService.pick(hivemindNodePicks(hivemindService.nodes), { placeHolder: localize('hivemind.continue.placeholder', "Pick up where this work left off") });
			id = pick?.node.id;
		}
		if (id) {
			// The Chat panel's /continue command does the work: it loads the node and records a child node.
			await commandService.executeCommand('workbench.action.chat.open', { query: `/continue ${id} `, isPartialQuery: true });
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'hivemindide.hivemind.openProjectNotes', title: localize2('hivemind.openNotes', "Open Project Notes"), category: CATEGORY, f1: true });
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const folder = accessor.get(IHivemindService).folder;
		if (folder) {
			await accessor.get(IEditorService).openEditor({ resource: joinPath(folder, 'project.md') });
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: 'hivemindide.hivemind.revealFolder', title: localize2('hivemind.reveal', "Reveal .hivemind Folder"), category: CATEGORY, f1: true });
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const folder = accessor.get(IHivemindService).folder;
		if (folder) {
			await accessor.get(ICommandService).executeCommand('revealInExplorer', folder);
		}
	}
});
