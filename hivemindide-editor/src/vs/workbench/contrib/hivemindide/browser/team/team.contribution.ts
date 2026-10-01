/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  HivemindIDE team: the service, and its section in the Account tab.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { HivemindIDESettingsSections } from '../hivemindideSettingsSections.js';
import { ITeamService, TeamService } from './teamService.js';
import { TeamSettingsSection } from './teamSettingsSection.js';

registerSingleton(ITeamService, TeamService, InstantiationType.Delayed);

HivemindIDESettingsSections.register({ id: 'team', order: 30, tab: 'account', ctor: TeamSettingsSection });
