/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerMainProcessRemoteService } from '../../ipc/electron-browser/services.js';
import { HIVEMIND_NOTCH_CHANNEL_NAME, IHivemindNotchService } from '../common/hivemindNotch.js';

registerMainProcessRemoteService(IHivemindNotchService, HIVEMIND_NOTCH_CHANNEL_NAME);
