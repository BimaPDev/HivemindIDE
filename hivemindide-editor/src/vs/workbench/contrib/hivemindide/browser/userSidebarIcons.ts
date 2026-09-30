/*---------------------------------------------------------------------------------------------
 *  Icons for the HivemindIDE User sidebar.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';

export const hivemindideUserViewIcon = registerIcon(
	'hivemindide-user-view-icon',
	Codicon.account,
	localize('hivemindideUserViewIcon', 'View icon of the HivemindIDE User sidebar.')
);
