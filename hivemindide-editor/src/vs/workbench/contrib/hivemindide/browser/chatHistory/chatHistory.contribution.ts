/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE chat History: a chip beside "Local" under the chat input that
 *  lists earlier chats, newest first, and reopens the one picked in the Chat
 *  panel. Chats can be searched by title and deleted from the list.
 *
 *  Uses the chat service's own record of sessions; nothing new is stored.
 *--------------------------------------------------------------------------------------------*/

import { $, reset } from '../../../../../base/browser/dom.js';
import { ActionViewItem } from '../../../../../base/browser/ui/actionbar/actionViewItems.js';
import { renderLabelWithIcons } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { fromNow } from '../../../../../base/common/date.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../../nls.js';
import { IActionViewItemService } from '../../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { ChatViewPaneTarget, IChatWidgetService } from '../../../chat/browser/chat.js';
import { ChatContextKeys } from '../../../chat/common/actions/chatContextKeys.js';
import { IChatDetail, IChatService } from '../../../chat/common/chatService/chatService.js';
import { ChatAgentLocation } from '../../../chat/common/constants.js';

const CHAT_HISTORY_COMMAND_ID = 'hivemindide.chat.history';

interface IChatHistoryItem extends IQuickPickItem {
	readonly chat: IChatDetail;
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: CHAT_HISTORY_COMMAND_ID,
			title: localize2('hivemindide.chat.history', 'Chat History'),
			category: localize2('hivemindide.category', 'HivemindIDE'),
			icon: Codicon.history,
			f1: true,
			precondition: ChatContextKeys.enabled,
			menu: {
				id: MenuId.ChatInputSecondary,
				// Right after "Local" and before the permission picker.
				order: 0.7,
				group: 'navigation',
				when: ContextKeyExpr.and(
					ChatContextKeys.enabled,
					ChatContextKeys.location.isEqualTo(ChatAgentLocation.Chat),
					ChatContextKeys.inQuickChat.negate(),
				),
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const chatService = accessor.get(IChatService);
		const chatWidgetService = accessor.get(IChatWidgetService);
		const quickInputService = accessor.get(IQuickInputService);

		const current = chatWidgetService.lastFocusedWidget?.viewModel?.sessionResource.toString();
		const store = new DisposableStore();
		const picker = store.add(quickInputService.createQuickPick<IChatHistoryItem>({ useSeparators: true }));
		picker.title = localize('hivemindide.chat.history.title', "Chat History");
		picker.placeholder = localize('hivemindide.chat.history.placeholder', "Search earlier chats by title");
		picker.matchOnDescription = true;
		picker.busy = true;
		picker.show();

		const deleteButton = { iconClass: ThemeIcon.asClassName(Codicon.trash), tooltip: localize('hivemindide.chat.history.delete', "Delete This Chat") };
		const load = async () => {
			const [live, saved] = await Promise.all([chatService.getLiveSessionItems(), chatService.getHistorySessionItems()]);
			// A chat can be both open and saved: keep one entry, the freshest.
			const byResource = new Map<string, IChatDetail>();
			for (const chat of [...saved, ...live]) {
				const key = chat.sessionResource.toString();
				const known = byResource.get(key);
				if (!known || chat.lastMessageDate > known.lastMessageDate) {
					byResource.set(key, chat);
				}
			}
			const chats = [...byResource.values()].filter(c => c.lastMessageDate > 0).sort((a, b) => b.lastMessageDate - a.lastMessageDate);
			picker.items = toItems(chats, current, deleteButton);
			picker.busy = false;
		};

		store.add(picker.onDidTriggerItemButton(async e => {
			await chatService.removeHistoryEntry(e.item.chat.sessionResource);
			await load();
		}));
		store.add(picker.onDidAccept(() => {
			const chat = picker.selectedItems[0]?.chat;
			picker.hide();
			if (chat) {
				chatWidgetService.openSession(chat.sessionResource, ChatViewPaneTarget);
			}
		}));
		store.add(picker.onDidHide(() => store.dispose()));
		await load();
	}
});

/** Newest first, under Today / Yesterday / This week / Earlier. */
function toItems(chats: readonly IChatDetail[], current: string | undefined, deleteButton: { iconClass: string; tooltip: string }): (IChatHistoryItem | IQuickPickSeparator)[] {
	const startOfToday = new Date().setHours(0, 0, 0, 0);
	const day = 24 * 60 * 60 * 1000;
	const groupOf = (time: number) => time >= startOfToday ? localize('hivemindide.chat.history.today', "Today")
		: time >= startOfToday - day ? localize('hivemindide.chat.history.yesterday', "Yesterday")
			: time >= startOfToday - 6 * day ? localize('hivemindide.chat.history.week', "This week")
				: localize('hivemindide.chat.history.earlier', "Earlier");
	const items: (IChatHistoryItem | IQuickPickSeparator)[] = [];
	let group: string | undefined;
	for (const chat of chats) {
		const g = groupOf(chat.lastMessageDate);
		if (g !== group) {
			group = g;
			items.push({ type: 'separator', label: g });
		}
		const isCurrent = chat.sessionResource.toString() === current;
		items.push({
			chat,
			label: chat.title || localize('hivemindide.chat.history.untitled', "Untitled chat"),
			iconClass: ThemeIcon.asClassName(chat.isActive ? Codicon.commentDiscussion : Codicon.history),
			description: isCurrent ? localize('hivemindide.chat.history.current', "{0} · current", fromNow(chat.lastMessageDate, true)) : fromNow(chat.lastMessageDate, true),
			buttons: isCurrent ? [] : [deleteButton],
		});
	}
	return items;
}

/** The chip under the chat input: a history icon and "History", drawn like "Local" beside it. */
class ChatHistoryChip extends ActionViewItem {

	override render(container: HTMLElement): void {
		super.render(container);
		container.classList.add('chat-input-picker-item');
	}

	protected override updateLabel(): void {
		if (this.label) {
			reset(this.label, ...renderLabelWithIcons(`$(${Codicon.history.id})`), $('span.chat-input-picker-label', undefined, localize('hivemindide.chat.history.chip', "History")));
			this.label.setAttribute('aria-label', localize('hivemindide.chat.history.aria', "Chat history: open an earlier chat"));
		}
	}
}

class ChatHistoryChipContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.hivemindide.chatHistoryChip';

	constructor(@IActionViewItemService actionViewItemService: IActionViewItemService) {
		super();
		this._register(actionViewItemService.register(MenuId.ChatInputSecondary, CHAT_HISTORY_COMMAND_ID, (action, options) =>
			new ChatHistoryChip(undefined, action, { ...options, icon: false, label: true })));
	}
}

registerWorkbenchContribution2(ChatHistoryChipContribution.ID, ChatHistoryChipContribution, WorkbenchPhase.BlockRestore);
