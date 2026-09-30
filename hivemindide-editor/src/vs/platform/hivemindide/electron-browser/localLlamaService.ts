/*---------------------------------------------------------------------------------------------
 *  HivemindIDE local models: workbench-side proxy to the main-process llama.cpp manager.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../ipc/electron-browser/services.js';
import { ILocalLlamaService, LOCAL_LLAMA_CHANNEL_NAME } from '../common/localLlama.js';

registerMainProcessRemoteService(ILocalLlamaService, LOCAL_LLAMA_CHANNEL_NAME);
