/*---------------------------------------------------------------------------------------------
 *  Extra sections for the HivemindIDE settings surfaces.
 *
 *  Both the User sidebar's Settings tab and the HivemindIDE Settings page
 *  render the sections registered here after their built-in ones. It exists
 *  so desktop-only features (local models need the main process) can add a
 *  section from the electron-browser entry point without the browser code,
 *  which web builds also load, importing them.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { BrandedService, IConstructorSignature } from '../../../../platform/instantiation/common/instantiation.js';

export interface IHivemindIDESettingsSectionRenderOptions {
	/** The host already titles the page for this section (e.g. its own sidebar tab), so skip the section heading. */
	readonly standalone?: boolean;
}

export interface IHivemindIDESettingsSection extends IDisposable {
	/** Renders into `parent` and keeps itself up to date until disposed. */
	render(parent: HTMLElement, options?: IHivemindIDESettingsSectionRenderOptions): void;
}

/** The User sidebar tab a section appears on. */
export type HivemindIDESettingsSectionTab = 'localAI' | 'servicedAI';

export interface IHivemindIDESettingsSectionDescriptor {
	readonly id: string;
	readonly order: number;
	/** Defaults to `localAI`. */
	readonly tab?: HivemindIDESettingsSectionTab;
	readonly ctor: IConstructorSignature<IHivemindIDESettingsSection>;
}

class HivemindIDESettingsSectionsRegistry {

	private readonly _onDidChange = new Emitter<void>();
	readonly onDidChange: Event<void> = this._onDidChange.event;

	private readonly descriptors: IHivemindIDESettingsSectionDescriptor[] = [];

	register<Services extends BrandedService[]>(section: { readonly id: string; readonly order: number; readonly tab?: HivemindIDESettingsSectionTab; readonly ctor: new (...services: Services) => IHivemindIDESettingsSection }): IDisposable {
		// Same erasure registerWorkbenchContribution2 relies on: the instantiation
		// service supplies the services, so their concrete tuple does not matter here.
		const descriptor = section as unknown as IHivemindIDESettingsSectionDescriptor;
		this.descriptors.push(descriptor);
		this.descriptors.sort((a, b) => a.order - b.order);
		this._onDidChange.fire();
		return toDisposable(() => {
			const index = this.descriptors.indexOf(descriptor);
			if (index >= 0) {
				this.descriptors.splice(index, 1);
				this._onDidChange.fire();
			}
		});
	}

	get sections(): readonly IHivemindIDESettingsSectionDescriptor[] {
		return this.descriptors;
	}

	sectionsFor(tab: HivemindIDESettingsSectionTab): readonly IHivemindIDESettingsSectionDescriptor[] {
		return this.descriptors.filter(d => (d.tab ?? 'localAI') === tab);
	}
}

export const HivemindIDESettingsSections = new HivemindIDESettingsSectionsRegistry();

/** Config keys a section manages itself; hosts must not re-render the whole page for them. */
export const SELF_RENDERING_CONFIG_PREFIX = 'hivemindide.localModels';
/** The same, for the Serviced AI section. */
export const SELF_RENDERING_CONFIG_PREFIXES = [SELF_RENDERING_CONFIG_PREFIX, 'hivemindide.failover', 'hivemindide.serviced', 'hivemindide.shell'];
