/*---------------------------------------------------------------------------------------------
 *  Visor accent — a lens-style gradient on the workbench's accent strokes.
 *
 *  A theme color is a single value, so a theme alone cannot paint the shifting
 *  tint of a mirrored lens. These three colors are the gradient's stops; the
 *  stylesheet draws them on the active tab, the activity bar and panel
 *  indicators, the progress bar, primary buttons and the cursor.
 *
 *  They default to null on purpose: a null color emits no CSS variable, which
 *  makes every gradient in visor.css invalid and therefore inert. Only a theme
 *  that sets all three (the Hivemind themes) gets the effect; every other theme
 *  renders exactly as upstream.
 *--------------------------------------------------------------------------------------------*/

import './media/visor.css';
import { localize } from '../../../../nls.js';
import { registerColor } from '../../../../platform/theme/common/colorUtils.js';

registerColor('hivemind.visorStart', null, localize('hivemind.visorStart', "First stop of the visor accent gradient. Leave unset to disable the gradient accent."));
registerColor('hivemind.visorMid', null, localize('hivemind.visorMid', "Middle stop of the visor accent gradient."));
registerColor('hivemind.visorEnd', null, localize('hivemind.visorEnd', "Last stop of the visor accent gradient."));

// The chat input's working beam steps through these, one per full rotation.
// Same null-default contract: a theme that leaves them unset keeps the stock
// single-color beam.
registerColor('hivemind.beam1', null, localize('hivemind.beam1', "First color of the chat working beam cycle. Leave unset to keep a single-color beam."));
registerColor('hivemind.beam2', null, localize('hivemind.beam2', "Second color of the chat working beam cycle."));
registerColor('hivemind.beam3', null, localize('hivemind.beam3', "Third color of the chat working beam cycle."));
registerColor('hivemind.beam4', null, localize('hivemind.beam4', "Fourth color of the chat working beam cycle."));
registerColor('hivemind.beam5', null, localize('hivemind.beam5', "Fifth color of the chat working beam cycle."));

// The hairline ring upstream keeps around the chat input while the beam runs.
// Hivemind themes set it transparent so only the beam shows; unset keeps the
// stock ring.
registerColor('hivemind.beamTrack', null, localize('hivemind.beamTrack', "Border of the chat input behind the working beam. Leave unset to keep the default ring."));
