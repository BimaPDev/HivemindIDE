/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE team: who may share, and who may change whom.
 *
 *  The same rules as coordinationd's team.Can* functions, so the UI offers only
 *  what the hub will allow. The hub enforces them either way: these decide
 *  which buttons to show, not what is permitted.
 *--------------------------------------------------------------------------------------------*/

export type Role = 'owner' | 'admin' | 'member';

/** Owners and admins share, as members or admins. Nobody is invited as owner. */
export function canInvite(actor: Role, as: Role): boolean {
	return (actor === 'owner' || actor === 'admin') && (as === 'member' || as === 'admin');
}

/** The owner sets anyone else to member or admin; an admin only promotes members to admin. */
export function canSetRole(actor: Role, target: Role, to: Role): boolean {
	if (target === 'owner' || to === 'owner') {
		return false;
	}
	return actor === 'owner' || (actor === 'admin' && target === 'member' && to === 'admin');
}

/** The owner removes anyone else; an admin removes members only. */
export function canRemove(actor: Role, target: Role): boolean {
	return target !== 'owner' && (actor === 'owner' || (actor === 'admin' && target === 'member'));
}

export function canTransfer(actor: Role, target: Role): boolean {
	return actor === 'owner' && target !== 'owner';
}

export function canShare(actor: Role): boolean {
	return actor === 'owner' || actor === 'admin';
}
