/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { canInvite, canRemove, canSetRole, canShare, canTransfer, Role } from '../../common/teamPolicy.js';

suite('HivemindIDE team policy', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const roles: Role[] = ['owner', 'admin', 'member'];

	// The same table coordinationd's TestPolicy checks, so the two cannot drift silently.
	test('matches the hub: who may change whose role', () => {
		const allowed = roles.flatMap(actor => roles.flatMap(target => roles.filter(to => canSetRole(actor, target, to)).map(to => `${actor}:${target}->${to}`)));
		assert.deepStrictEqual(allowed, [
			'owner:admin->admin', 'owner:admin->member', 'owner:member->admin', 'owner:member->member',
			'admin:member->admin',
		]);
	});

	test('only owners and admins share; admins remove members only; only the owner hands over', () => {
		assert.deepStrictEqual({
			share: roles.filter(canShare),
			inviteAs: roles.flatMap(actor => roles.filter(as => canInvite(actor, as)).map(as => `${actor}:${as}`)),
			remove: roles.flatMap(actor => roles.filter(target => canRemove(actor, target)).map(target => `${actor}:${target}`)),
			transfer: roles.flatMap(actor => roles.filter(target => canTransfer(actor, target)).map(target => `${actor}:${target}`)),
		}, {
			share: ['owner', 'admin'],
			inviteAs: ['owner:admin', 'owner:member', 'admin:admin', 'admin:member'],
			remove: ['owner:admin', 'owner:member', 'admin:member'],
			transfer: ['owner:admin', 'owner:member'],
		});
	});
});
