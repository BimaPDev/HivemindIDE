/*---------------------------------------------------------------------------------------------
 *  Icons for the HivemindIDE Maps sidebar.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { localize } from '../../../../nls.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';

export const hivemindideViewIcon = registerIcon(
	'hivemindide-view-icon',
	Codicon.map,
	localize('hivemindideViewIcon', 'View icon of the HivemindIDE Maps sidebar.')
);

export const hivemindideAgentTreeRefreshIcon = registerIcon(
	'hivemindide-agent-tree-refresh',
	Codicon.refresh,
	localize('hivemindideAgentTreeRefreshIcon', 'Refresh / resample the agent spawn tree.')
);
