/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE team: the Team section of the Account tab.
 *
 *  Create a team for this repo (you become its owner) or join one with an
 *  invite code; see who is in it and their roles; and, if you are an owner or
 *  admin, share it: invite people as members or admins, change roles, remove
 *  people, and (owner only) hand ownership over. The actions shown follow
 *  teamPolicy.ts; the hub enforces the same rules whatever the UI shows.
 *--------------------------------------------------------------------------------------------*/

import '../localModels/media/localModelsSettings.css';
import '../serviced/media/servicedAI.css';
import { $, addDisposableListener, append, clearNode } from '../../../../../base/browser/dom.js';
import { Button } from '../../../../../base/browser/ui/button/button.js';
import { fromNow } from '../../../../../base/common/date.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { localize } from '../../../../../nls.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { defaultButtonStyles } from '../../../../../platform/theme/browser/defaultStyles.js';
import { TeamMember, TeamRole } from '../../../../services/hivemindide/common/coordinationClient.js';
import { canInvite, canRemove, canSetRole, canShare, canTransfer } from '../../common/teamPolicy.js';
import { IHivemindIDESettingsSection } from '../hivemindideSettingsSections.js';
import { IHivemindService } from '../hivemind/hivemindService.js';
import { ITeamService } from './teamService.js';

export class TeamSettingsSection extends Disposable implements IHivemindIDESettingsSection {

	private root: HTMLElement | undefined;
	private readonly content = this._register(new MutableDisposable<DisposableStore>());

	constructor(
		@ITeamService private readonly teamService: ITeamService,
		@IHivemindService private readonly hivemindService: IHivemindService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@INotificationService private readonly notificationService: INotificationService,
		@IDialogService private readonly dialogService: IDialogService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
	}

	render(parent: HTMLElement): void {
		this.root = append(parent, $('.hivemindide-lm.hivemindide-sai'));
		this._register(this.teamService.onDidChange(() => this.renderNow()));
		this.renderNow();
	}

	private renderNow(): void {
		if (!this.root) {
			return;
		}
		const store = new DisposableStore();
		this.content.value = store;
		clearNode(this.root);
		const root = this.root;
		heading(root, localize('team.heading', "Team"));
		const state = this.teamService.state;
		const hub = this.teamService.hub;

		switch (state.kind) {
			case 'unconfigured':
				note(root, localize('team.unconfigured', "Teams live on your coordination hub. Set its URL and this repo's ID first; everyone on the team uses the same two."));
				this.button(root, store, localize('team.configure', "Set Coordination Hub…"), false, () => this.commandService.executeCommand('workbench.action.openSettings', 'hivemindide.agentTree'));
				return;
			case 'loading':
				note(root, localize('team.loading', "Checking the team…"));
				return;
			case 'error':
				note(root, localize('team.error', "Could not reach the coordination hub at {0}: {1}", hub?.url ?? '', state.message));
				this.button(root, store, localize('team.retry', "Retry"), true, () => this.teamService.refresh());
				return;
			case 'signedOut':
				if (state.hasTeam) {
					note(root, localize('team.hasTeam', "{0} has a team. Ask one of its owners or admins for an invite code, then join with it.", hub?.repoId ?? ''));
					this.button(root, store, localize('team.join', "Join With Invite Code…"), false, () => this.join());
				} else {
					note(root, localize('team.noTeam', "{0} has no team yet, so anyone who can reach the hub can use it. Create a team to make it members-only: you become its owner, and only owners and admins can invite people.", hub?.repoId ?? ''));
					const buttons = append(root, $('.hivemindide-lm-buttons'));
					this.button(buttons, store, localize('team.create', "Create Team…"), false, () => this.create());
					this.button(buttons, store, localize('team.joinInstead', "Join With Invite Code…"), true, () => this.join());
				}
				return;
			case 'signedIn':
				this.renderTeam(root, store, state.view.you, state.view.members, state.view.invites ?? []);
				return;
		}
	}

	private renderTeam(root: HTMLElement, store: DisposableStore, you: TeamMember, members: readonly TeamMember[], invites: readonly { id: string; role: TeamRole; created_by: string; expires_at: string; max_uses: number; uses: number }[]): void {
		const repo = this.teamService.hub?.repoId ?? '';
		note(root, you.role === 'owner'
			? localize('team.you.owner', "You own the {0} team. You can invite people, manage roles and hand ownership over.", repo)
			: you.role === 'admin'
				? localize('team.you.admin', "You are an admin of the {0} team. You can invite people and promote members to admin.", repo)
				: localize('team.you.member', "You are a member of the {0} team. Only owners and admins can invite people.", repo));

		for (const member of members) {
			const card = append(root, $('.hivemindide-sai-card.compact'));
			const head = append(card, $('.hivemindide-sai-card-head'));
			append(head, $('span.hivemindide-sai-name')).textContent = member.user_id === you.user_id ? localize('team.you', "{0} (you)", member.display_name) : member.display_name;
			append(head, $('span.hivemindide-sai-kind')).textContent = roleName(member.role);
			append(card, $('.hivemindide-sai-line.dim')).textContent = member.invited_by
				? localize('team.joined', "joined {0}, invited by {1}", fromNow(Date.parse(member.joined_at), true), member.invited_by)
				: localize('team.created', "created the team {0}", fromNow(Date.parse(member.joined_at), true));

			if (member.user_id === you.user_id) {
				continue;
			}
			const actions = append(card, $('.hivemindide-lm-model-actions'));
			if (canSetRole(you.role, member.role, 'admin') && member.role !== 'admin') {
				this.link(actions, store, localize('team.makeAdmin', "Make admin"), () => this.teamService.setRole(member.user_id, 'admin'));
			}
			if (canSetRole(you.role, member.role, 'member') && member.role !== 'member') {
				this.link(actions, store, localize('team.makeMember', "Make member"), () => this.teamService.setRole(member.user_id, 'member'));
			}
			if (canTransfer(you.role, member.role)) {
				this.link(actions, store, localize('team.transfer', "Make owner…"), () => this.transfer(member));
			}
			if (canRemove(you.role, member.role)) {
				this.link(actions, store, localize('team.remove', "Remove…"), () => this.remove(member));
			}
		}

		if (canShare(you.role)) {
			heading(root, localize('team.invites', "Invites"));
			if (invites.length === 0) {
				append(root, $('p.hivemindide-lm-empty')).textContent = localize('team.invites.none', "No pending invites.");
			}
			for (const invite of invites) {
				const card = append(root, $('.hivemindide-sai-card.compact'));
				const head = append(card, $('.hivemindide-sai-card-head'));
				append(head, $('span.hivemindide-sai-name')).textContent = localize('team.invite.as', "Joins as {0}", roleName(invite.role).toLowerCase());
				append(head, $('span.hivemindide-sai-kind')).textContent = localize('team.invite.uses', "{0}/{1} used", invite.uses, invite.max_uses);
				append(card, $('.hivemindide-sai-line.dim')).textContent = localize('team.invite.meta', "by {0}, expires {1}", invite.created_by, fromNow(Date.parse(invite.expires_at), true));
				this.link(append(card, $('.hivemindide-lm-model-actions')), store, localize('team.invite.revoke', "Revoke"), () => this.teamService.revokeInvite(invite.id));
			}
			this.button(append(root, $('.hivemindide-lm-buttons')), store, localize('team.inviteButton', "Invite Someone…"), false, () => this.invite(you.role));
		}

		const buttons = append(root, $('.hivemindide-lm-buttons'));
		this.button(buttons, store, localize('team.refresh', "Refresh"), true, () => this.teamService.refresh());
		if (you.role !== 'owner') {
			this.button(buttons, store, localize('team.leave', "Leave Team…"), true, () => this.leave());
		}
		this.button(buttons, store, localize('team.signOut', "Sign Out Here"), true, () => this.teamService.signOut());
	}

	// ---- Actions ------------------------------------------------------------------------

	private async displayName(title: string): Promise<string | undefined> {
		return (await this.quickInputService.input({
			title,
			prompt: localize('team.name.prompt', "Your name as teammates will see it."),
			value: this.hivemindService.author,
			validateInput: async v => v.trim() ? undefined : localize('team.name.empty', "Enter a name."),
		}))?.trim();
	}

	private async create(): Promise<void> {
		const name = await this.displayName(localize('team.create.title', "Create a Team"));
		if (!name) {
			return;
		}
		const secret = await this.quickInputService.input({
			title: localize('team.create.secret', "Hub Setup Secret"),
			prompt: localize('team.create.secretPrompt', "Only if your hub was started with COORDINATION_TEAM_SETUP_SECRET. Otherwise leave it empty."),
			password: true,
		});
		if (secret === undefined) {
			return;
		}
		await this.teamService.createTeam(name, secret || undefined);
		this.notificationService.info(localize('team.created.done', "You are the owner of {0}'s team. From now on it is members-only.", this.teamService.hub?.repoId ?? ''));
	}

	private async join(): Promise<void> {
		const code = (await this.quickInputService.input({
			title: localize('team.join.title', "Join a Team"),
			prompt: localize('team.join.prompt', "The invite code an owner or admin gave you (it starts with hvi_)."),
			password: true,
			validateInput: async v => /^hvi_\S+$/.test(v.trim()) ? undefined : localize('team.join.invalid', "An invite code starts with hvi_."),
		}))?.trim();
		if (!code) {
			return;
		}
		const name = await this.displayName(localize('team.join.title', "Join a Team"));
		if (name) {
			await this.teamService.joinTeam(code, name);
		}
	}

	private async invite(actor: TeamRole): Promise<void> {
		const roles: (IQuickPickItem & { role: TeamRole })[] = (['member', 'admin'] as TeamRole[]).filter(r => canInvite(actor, r)).map(role => ({
			role,
			label: roleName(role),
			detail: role === 'admin' ? localize('team.role.adminDetail', "Can invite people and manage members.") : localize('team.role.memberDetail', "Can work with the team, but cannot invite anyone."),
		}));
		const role = (await this.quickInputService.pick(roles, { title: localize('team.invite.title', "Invite Someone"), placeHolder: localize('team.invite.role', "They join as…") }))?.role;
		if (!role) {
			return;
		}
		const expiry = await this.quickInputService.pick([
			{ label: localize('team.invite.day', "1 day"), hours: 24 },
			{ label: localize('team.invite.week', "7 days"), hours: 24 * 7 },
			{ label: localize('team.invite.month', "30 days"), hours: 24 * 30 },
		], { title: localize('team.invite.title', "Invite Someone"), placeHolder: localize('team.invite.expiry', "The code stops working after…") });
		if (!expiry) {
			return;
		}
		const uses = await this.quickInputService.pick([
			{ label: localize('team.invite.one', "One person"), uses: 1 },
			{ label: localize('team.invite.five', "Up to 5 people"), uses: 5 },
			{ label: localize('team.invite.many', "Up to 25 people"), uses: 25 },
		], { title: localize('team.invite.title', "Invite Someone"), placeHolder: localize('team.invite.usesPrompt', "The code can be used by…") });
		if (!uses) {
			return;
		}
		const code = await this.teamService.invite(role, expiry.hours, uses.uses);
		await this.clipboardService.writeText(code);
		await this.dialogService.info(
			localize('team.invite.ready', "Invite code copied"),
			localize('team.invite.readyDetail', "It is on your clipboard, and this is the only time it is shown. Send it to the person you are inviting over a private channel. They join from Account > Team > Join With Invite Code.\n\n{0}", code),
		);
	}

	private async remove(member: TeamMember): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			message: localize('team.remove.confirm', "Remove {0} from the team?", member.display_name),
			detail: localize('team.remove.detail', "They are signed out on every machine at once and need a new invite to come back."),
			primaryButton: localize('team.remove.button', "Remove"),
		});
		if (confirmed) {
			await this.teamService.removeMember(member.user_id);
		}
	}

	private async transfer(member: TeamMember): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			message: localize('team.transfer.confirm', "Make {0} the owner?", member.display_name),
			detail: localize('team.transfer.detail', "There is one owner. You become an admin, and only {0} can hand ownership back.", member.display_name),
			primaryButton: localize('team.transfer.button', "Make Owner"),
		});
		if (confirmed) {
			await this.teamService.transferOwnership(member.user_id);
		}
	}

	private async leave(): Promise<void> {
		const { confirmed } = await this.dialogService.confirm({
			message: localize('team.leave.confirm', "Leave the team?"),
			detail: localize('team.leave.detail', "You need a new invite from an owner or admin to come back."),
			primaryButton: localize('team.leave.button', "Leave"),
		});
		if (confirmed) {
			await this.teamService.leave();
		}
	}

	// ---- Helpers --------------------------------------------------------------------------

	private button(parent: HTMLElement, store: DisposableStore, label: string, secondary: boolean, run: () => unknown): void {
		const button = store.add(new Button(parent, { ...defaultButtonStyles, secondary }));
		button.label = label;
		store.add(button.onDidClick(() => this.run(run)));
	}

	private link(parent: HTMLElement, store: DisposableStore, label: string, run: () => unknown): void {
		const link = append(parent, $('button.hivemindide-lm-link')) as HTMLButtonElement;
		link.type = 'button';
		link.textContent = label;
		store.add(addDisposableListener(link, 'click', e => {
			e.preventDefault();
			this.run(run);
		}));
	}

	private async run(task: () => unknown): Promise<void> {
		try {
			await task();
		} catch (err) {
			this.notificationService.error(err instanceof Error ? err.message : String(err));
		}
	}
}

function roleName(role: TeamRole): string {
	return role === 'owner' ? localize('team.role.owner', "Owner") : role === 'admin' ? localize('team.role.admin', "Admin") : localize('team.role.member', "Member");
}

function heading(parent: HTMLElement, text: string): void {
	append(parent, $('.hivemindide-lm-heading')).textContent = text;
}

function note(parent: HTMLElement, text: string): void {
	append(parent, $('p.hivemindide-lm-note')).textContent = text;
}
