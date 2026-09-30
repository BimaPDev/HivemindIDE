/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../ipc/electron-browser/services.js';
import { HIVEMIND_SHELL_CHANNEL_NAME, IHivemindShellService } from '../common/hivemindShell.js';

registerMainProcessRemoteService(IHivemindShellService, HIVEMIND_SHELL_CHANNEL_NAME);
