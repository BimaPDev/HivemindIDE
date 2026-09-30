/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE Serviced AI: the service and its tab in the User sidebar.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { HivemindIDESettingsSections } from '../hivemindideSettingsSections.js';
import { IServicedAIService, ServicedAIService } from './servicedAIService.js';
import { ServicedAISettingsSection } from './servicedAISettingsSection.js';

registerSingleton(IServicedAIService, ServicedAIService, InstantiationType.Delayed);

HivemindIDESettingsSections.register({ id: 'servicedAI', order: 20, tab: 'servicedAI', ctor: ServicedAISettingsSection });
