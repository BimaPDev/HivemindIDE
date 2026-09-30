/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  Where the usage notch sits: an edge of the window and how far along it.
 *
 *  The user drags the notch anywhere; on release it snaps to the nearest edge.
 *  The position along the edge is kept as a fraction of the edge's length,
 *  so it stays in the same place, proportionally, when the window resizes.
 *--------------------------------------------------------------------------------------------*/

export type NotchEdge = 'left' | 'right' | 'top' | 'bottom';

export interface INotchPlacement {
	readonly edge: NotchEdge;
	/** Where the notch's middle sits along the edge, 0 (top or left end) to 1. */
	readonly offset: number;
}

/**
 * Low on the activity bar: the notch is exactly as wide as the bar, and the
 * stretch between its view icons and its account and settings icons is empty,
 * so there it covers nothing.
 */
export const DEFAULT_NOTCH_PLACEMENT: INotchPlacement = { edge: 'left', offset: 0.6 };

const EDGES: readonly NotchEdge[] = ['left', 'right', 'top', 'bottom'];

export function isVerticalEdge(edge: NotchEdge): boolean {
	return edge === 'left' || edge === 'right';
}

/** The placement for a notch dropped at (x, y) in a window of `width` × `height`. */
export function snapNotchPlacement(x: number, y: number, width: number, height: number): INotchPlacement {
	const distances: [NotchEdge, number][] = [['left', x], ['right', width - x], ['top', y], ['bottom', height - y]];
	const [edge] = distances.reduce((best, d) => d[1] < best[1] ? d : best);
	const offset = isVerticalEdge(edge) ? y / Math.max(1, height) : x / Math.max(1, width);
	return { edge, offset: clamp(offset, 0, 1) };
}

/**
 * Pixels from the top (vertical edges) or left (horizontal edges) of the
 * window to the notch's start. Keeps the whole notch, and `margin` more for
 * its shoulders, inside the window however small it gets.
 */
export function notchStart(placement: INotchPlacement, edgeLength: number, notchLength: number, margin: number): number {
	const wanted = placement.offset * edgeLength - notchLength / 2;
	const max = edgeLength - notchLength - margin;
	return max < margin ? Math.max(0, (edgeLength - notchLength) / 2) : clamp(wanted, margin, max);
}

/** The stored placement, or the default when there is none or it is not one. */
export function parseNotchPlacement(raw: string | undefined): INotchPlacement {
	if (raw) {
		try {
			const value = JSON.parse(raw);
			if (EDGES.includes(value?.edge) && typeof value.offset === 'number' && isFinite(value.offset)) {
				return { edge: value.edge, offset: clamp(value.offset, 0, 1) };
			}
		} catch {
			// fall through to the default
		}
	}
	return DEFAULT_NOTCH_PLACEMENT;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}
