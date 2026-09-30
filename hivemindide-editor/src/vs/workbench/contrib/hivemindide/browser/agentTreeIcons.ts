/*---------------------------------------------------------------------------------------------
 *  Icons for the HivemindIDE Agents sidebar.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';

export const hivemindideViewIcon = registerIcon(
	'hivemindide-view-icon',
	Codicon.organization,
	localize('hivemindideViewIcon', 'View icon of the HivemindIDE Agents sidebar.')
);

export const hivemindideAgentTreeRefreshIcon = registerIcon(
	'hivemindide-agent-tree-refresh',
	Codicon.refresh,
	localize('hivemindideAgentTreeRefreshIcon', 'Refresh / resample the agent spawn tree.')
);
