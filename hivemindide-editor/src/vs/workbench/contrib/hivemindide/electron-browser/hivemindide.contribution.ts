/*---------------------------------------------------------------------------------------------
 *  HivemindIDE desktop-only feature registration.
 *
 *  The ONLY HivemindIDE file workbench.desktop.main.ts imports. Features that
 *  need the main process (spawning llama.cpp) register here so the browser
 *  entry point, which web builds also load, never pulls them in.
 *--------------------------------------------------------------------------------------------*/

// Proxy to the llama.cpp server manager in the main process.
import '../../../../platform/hivemindide/electron-browser/localLlamaService.js';

// Local GGUF models in the Chat panel: model picker vendor, default agent, workspace RAG, status bar.
import '../browser/localModels/localModels.contribution.js';

// Proxy to the hivemind shell runtime in the main process.
import '../../../../platform/hivemindide/electron-browser/hivemindShellService.js';

// Hivemind shell: provider/model routes in the model picker; agents run in the shell runtime.
import '../browser/shell/shell.contribution.js';

// Proxy to the MacBook notch window in the main process.
import '../../../../platform/hivemindide/electron-browser/hivemindNotchService.js';

// Usage notch: plan-limit rings on the window edge and alerts as a limit nears.
// On a Mac with a camera notch it moves into the notch itself.
// Here, not in the browser entry: it listens to the shell and to failover.
import '../browser/usageNotch/usageNotch.contribution.js';

// Serviced AI: API services, installed agent CLIs, combos and usage, in their own tab.
import '../browser/serviced/serviced.contribution.js';
