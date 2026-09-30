/*---------------------------------------------------------------------------------------------
 *  HivemindIDE feature registration.
 *
 *  This is the ONLY file referenced from workbench.common.main.ts. Adding a
 *  feature means adding a line here, not another edit to a file upstream owns —
 *  which is what keeps `git merge upstream/main` cheap.
 *--------------------------------------------------------------------------------------------*/

import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { UsageIndicatorContribution } from './usageIndicator.js';
import { HideCopilotContribution } from './hideCopilot.js';

// Registers the `hivemindide.*` settings schema as a side effect of the import.
import '../common/hivemindideConfiguration.js';

// Registers the Agents sidebar (author+AI spawn tree).
import './agentTree.contribution.js';

// Review editor opened when a graph node is clicked.
import './agentDetail.contribution.js';

// Two-layer settings: Cmd+, opens HivemindIDE Settings; button opens VS Code Settings.
import './hivemindideSettings.contribution.js';

// Hivemind: shared AI memory for each project in .hivemind/.
import './hivemind/hivemind.contribution.js';

// User sidebar: nested icon rail + content panel (inside the sidebar).
import './userSidebar.contribution.js';

// Visor accent: lens gradient on accent strokes, for themes that define it.
import './visor.js';

// Before ChatStatusBarEntry (BlockRestore) so the Copilot status icon never
// paints on a cold start.
registerWorkbenchContribution2(
	HideCopilotContribution.ID,
	HideCopilotContribution,
	WorkbenchPhase.BlockStartup
);

// Eventually: nothing here is needed to edit code, so it must not compete with
// startup. A feature that delays the first keystroke is not worth having.
registerWorkbenchContribution2(
	UsageIndicatorContribution.ID,
	UsageIndicatorContribution,
	WorkbenchPhase.Eventually
);
