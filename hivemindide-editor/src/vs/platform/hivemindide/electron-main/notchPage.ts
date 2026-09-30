/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/*---------------------------------------------------------------------------------------------
 *  The page inside the MacBook notch window.
 *
 *  Self-contained on purpose: it is loaded as a data URL, so it needs no build
 *  entry point, no preload and no Node access. The main process pushes state in
 *  with `window.__notch(state)` and the cursor with `window.__notchCursor(x, y)`;
 *  the page answers with console messages prefixed `hivemind-notch:`, which
 *  the main process reads and checks against a short list of actions. All
 *  text arrives as data and is only ever set with textContent.
 *
 *  Folded, it is the camera notch with two ears. Open, it is a wide black
 *  panel: tab pills and buttons in the band beside the camera, then dark
 *  cards: the agent (the Hivemind cell, its status and a checklist of its
 *  steps) and, beside it, the usage rings, a permission prompt or a limit
 *  banner. The Usage tab lists every limit window as a bar.
 *
 *  Motion is built to stay on the compositor, so it feels native:
 *  - the island is always laid out at full size and revealed with an animated
 *    clip-path, never resized, so opening costs no layout;
 *  - the mascot, the shoulders and the content move with transform and
 *    opacity only;
 *  - easings are real damped springs (the model SwiftUI uses), baked into
 *    CSS `linear()` curves;
 *  - the eyes glide toward the pointer every frame between cursor samples;
 *  - updates touch only what changed, so rings animate their fill.
 *
 *  The mascot is the Hivemind cell: a honey-colored hexagon whose eyes follow
 *  the pointer across the screen. It breathes and blinks when idle, bobs while
 *  an agent works, raises its brows when an agent asks, sweats when a limit is
 *  nearly gone, beams when a run finishes, dozes when nothing has happened for
 *  a while, and squishes when clicked.
 *--------------------------------------------------------------------------------------------*/

/** Prefix of the console messages the page sends the main process. */
export const NOTCH_MESSAGE_PREFIX = 'hivemind-notch:';

export function notchPageUrl(): string {
	return 'data:text/html;charset=utf-8,' + encodeURIComponent(NOTCH_PAGE);
}

const NOTCH_PAGE = /* html */`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>
:root {
	--bg: #000; --card: #0e0e10; --card-2: #151518; --line: rgba(255, 255, 255, 0.07);
	--fg: #f5f5f7; --dim: rgba(235, 235, 245, 0.55); --faint: rgba(235, 235, 245, 0.3); --track: #2a2a2e;
	--ok: #30d158; --elevated: #ffd60a; --high: #ff9f0a; --critical: #ff453a; --honey: #f6b73c;
	--ease: cubic-bezier(0.22, 1, 0.36, 1);
	/* Replaced at startup with real spring curves (see spring() below). */
	--open-ease: cubic-bezier(0.34, 1.2, 0.64, 1); --open-ms: 480ms;
	--close-ease: cubic-bezier(0.22, 1, 0.36, 1); --close-ms: 320ms;
	--band: 32px;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; background: transparent; overflow: hidden; user-select: none; -webkit-user-select: none;
	font: 12.5px/1.35 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", sans-serif; color: var(--fg); cursor: default;
	-webkit-font-smoothing: antialiased; }
button { font: inherit; color: inherit; border: 0; background: none; padding: 0; cursor: pointer; }
body.boot * { transition: none !important; }

/* ---- The island: laid out at full size once, revealed by its clip ---- */
#frame { position: absolute; top: 0; left: calc(50% - 300px); width: 600px; height: 100%; pointer-events: none; }
#island { position: absolute; inset: 0; background: var(--bg); will-change: clip-path;
	clip-path: inset(0px 186px 392px 186px round 0px 0px 13px 13px);
	transition: clip-path var(--close-ms) var(--close-ease); }
#frame.open #island { transition: clip-path var(--open-ms) var(--open-ease); }
/* Its shadow never changes size; it only fades, so nothing repaints while the island moves. */
#shadow { position: absolute; top: 0; left: 0; width: 600px; height: 200px; border-radius: 0 0 30px 30px;
	box-shadow: 0 24px 48px -18px rgba(0, 0, 0, 0.8), 0 0 0 0.5px rgba(255, 255, 255, 0.06); opacity: 0; transition: opacity 0.16s; }
#frame.open #shadow { opacity: 1; transition: opacity 0.35s 0.15s; }
/* Concave shoulders where the island meets the top of the screen; they ride its edges. */
.shoulder { position: absolute; top: 0; left: 0; width: 12px; height: 12px; will-change: transform;
	transition: transform var(--close-ms) var(--close-ease); }
#frame.open .shoulder { transition: transform var(--open-ms) var(--open-ease); }
#shoulder-l { background: radial-gradient(circle at 0 100%, transparent 11.5px, var(--bg) 12px); }
#shoulder-r { background: radial-gradient(circle at 100% 100%, transparent 11.5px, var(--bg) 12px); }

/* ---- Ears (folded) ---- */
#right-ear { position: absolute; top: 0; display: grid; place-items: center; transition: opacity 0.15s; }
#frame.open #right-ear { opacity: 0; }
.mini { width: 16px; height: 16px; transform: rotate(-90deg); }
.mini circle { fill: none; stroke-width: 3.2; }
.t { stroke: var(--track); } .v { stroke: var(--c, transparent); stroke-linecap: round; transition: stroke-dashoffset 0.7s var(--ease), stroke 0.3s; }
#ear-spinner { width: 13px; height: 13px; border-radius: 50%; border: 2px solid var(--track); border-top-color: var(--honey); animation: spin 0.8s linear infinite; display: none; }
#ear-ask { width: 8px; height: 8px; border-radius: 50%; background: var(--honey); display: none; animation: pulse 1.2s ease-in-out infinite; }
body.phase-working #ear-spinner { display: block; } body.phase-working #mini { display: none; }
body.phase-asking #ear-ask { display: block; } body.phase-asking #ear-spinner, body.phase-asking #mini { display: none; }
@keyframes spin { to { transform: rotate(360deg); } }
@keyframes pulse { 50% { transform: scale(0.55); opacity: 0.45; } }
.sev-ok { --c: var(--ok); } .sev-elevated { --c: var(--elevated); } .sev-high { --c: var(--high); } .sev-critical { --c: var(--critical); }

/* ---- Content: fades and settles in as the island opens ---- */
#bar, #panel { opacity: 0; transform: translateY(-8px) scale(0.98); transform-origin: 50% 0; pointer-events: none;
	transition: opacity 0.12s, transform 0.2s var(--ease); }
#frame.open #bar, #frame.open #panel { opacity: 1; transform: none; pointer-events: auto;
	transition: opacity 0.28s 0.07s, transform var(--open-ms) var(--open-ease) 0.03s; }
#bar { position: absolute; top: 0; left: 16px; right: 16px; height: var(--band); display: flex; align-items: center; justify-content: space-between; }
.group { display: flex; gap: 4px; }
.pill { height: 24px; min-width: 32px; padding: 0 9px; border-radius: 12px; display: grid; place-items: center; color: var(--dim); transition: background 0.15s, color 0.15s, transform 0.12s; }
.pill:hover { color: var(--fg); background: #141417; }
.pill:active { transform: scale(0.94); }
.pill.active { background: #1f1f23; color: var(--fg); }
.pill svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

#panel { position: absolute; top: calc(var(--band) + 6px); left: 12px; width: 576px; }
.card { background: linear-gradient(180deg, var(--card-2), var(--card)); border: 1px solid var(--line); border-radius: 18px; padding: 14px; min-width: 0; }
#home { display: grid; grid-template-columns: 190px 1fr; gap: 10px; }
#usage { display: none; flex-direction: column; gap: 8px; max-height: 330px; overflow-y: auto; scrollbar-width: none; }
#usage::-webkit-scrollbar { display: none; }
body.tab-usage #home { display: none; } body.tab-usage #usage { display: flex; }

/* Agent card */
#agent { cursor: pointer; }
#mascot-slot { height: 56px; }
#name { font-size: 15px; font-weight: 600; margin-top: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip { display: flex; align-items: center; gap: 6px; margin-top: 3px; color: var(--dim); font-size: 11.5px; min-width: 0; }
.chip span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip i { flex: none; }
.chip i { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); transition: background 0.3s; }
body.phase-working .chip i { background: var(--honey); animation: pulse 1.1s ease-in-out infinite; }
body.phase-asking .chip i { background: var(--honey); }
body.phase-done .chip i { background: var(--ok); }
#steps { list-style: none; margin: 12px 0 0; padding: 0; display: flex; flex-direction: column; gap: 7px; }
#steps li { display: flex; align-items: center; gap: 8px; min-width: 0; color: var(--dim); animation: step-in 0.3s var(--ease) both; }
#steps li span { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#steps li.in_progress { color: var(--fg); font-weight: 600; }
#steps li.completed { color: #d1d1d6; }
#steps li.pending { color: var(--faint); }
@keyframes step-in { from { opacity: 0; transform: translateX(-4px); } }
.si { width: 14px; height: 14px; flex: none; }
.si.run { border-radius: 50%; border: 1.6px solid var(--track); border-top-color: var(--fg); animation: spin 0.8s linear infinite; }
#empty-steps { margin-top: 12px; color: var(--faint); font-size: 11.5px; }

/* Side card: tiles, the permission prompt or the limit banner */
#side { display: flex; flex-direction: column; justify-content: center; position: relative; overflow: hidden; }
#tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(0, 1fr)); gap: 8px; }
.tile { background: #09090b; border: 1px solid var(--line); border-radius: 14px; padding: 12px 10px 10px; display: flex; flex-direction: column; align-items: center; text-align: center; min-width: 0; cursor: pointer; transition: transform 0.15s var(--ease), border-color 0.2s; }
.tile:hover { border-color: rgba(255, 255, 255, 0.14); }
.tile:active { transform: scale(0.97); }
.dial { position: relative; width: 46px; height: 46px; }
.dial svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.dial circle { fill: none; stroke-width: 3; }
.dial .glyph { position: absolute; inset: 0; display: grid; place-items: center; font-size: 10px; font-weight: 700; letter-spacing: 0.04em; }
.tile .pct { font-size: 19px; font-weight: 600; font-variant-numeric: tabular-nums; margin-top: 7px; letter-spacing: -0.01em; }
.tile .nm { font-size: 11.5px; margin-top: 1px; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tile .rs { font-size: 10.5px; color: var(--dim); margin-top: 1px; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#more { color: var(--dim); font-size: 11px; margin-top: 8px; text-align: right; }
.note { color: var(--dim); text-align: center; }

#ask-title { font-size: 13.5px; font-weight: 600; }
#ask-cmd { margin-top: 8px; padding: 8px 10px; border-radius: 10px; background: #070708; border: 1px solid var(--line); }
/* Clipped on the text itself, not the padded box, so no fifth line peeks through the padding. */
#ask-cmd-text { color: #e5e5ea; font: 11.5px/1.45 ui-monospace, "SF Mono", Menlo, monospace; white-space: pre-wrap; word-break: break-all;
	display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 4; overflow: hidden; max-height: calc(4 * 1.45em); }
#ask-buttons { display: flex; justify-content: flex-end; gap: 6px; margin-top: 10px; }
#ask-buttons button { height: 28px; min-width: 68px; max-width: 130px; padding: 0 12px; border-radius: 9px; font-weight: 600; font-size: 12px;
	white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: #1f1f23; transition: filter 0.12s, transform 0.1s; }
#ask-buttons button.ghost { background: transparent; color: #d1d1d6; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.14); }
#ask-buttons button.primary { background: var(--honey); color: #1c1203; }
#ask-buttons button:hover { filter: brightness(1.15); }
#ask-buttons button:active { transform: scale(0.96); }

#limit { position: absolute; inset: 0; flex-direction: column; justify-content: center; padding: 18px;
	background: radial-gradient(120% 140% at 70% 110%, rgba(255, 69, 58, 0.32), transparent 55%), radial-gradient(90% 120% at 10% -10%, rgba(125, 90, 255, 0.22), transparent 60%); }
#limit-title { font-size: 16px; font-weight: 600; } #limit-sub { color: var(--dim); margin-top: 3px; }
.side-view { display: none; animation: fade 0.25s var(--ease); } body.side-tiles #tiles-view, body.side-ask #ask, body.side-limit #limit, body.side-none #none { display: block; }
body.side-limit #limit { display: flex; }
@keyframes fade { from { opacity: 0; } }

/* Usage tab */
.prov { padding: 12px 14px; }
.prov-head { display: flex; align-items: center; gap: 8px; }
.prov-head .dial { width: 22px; height: 22px; } .prov-head .dial .glyph { font-size: 7px; }
.prov-head b { flex: 1; font-weight: 600; } .prov-head em { font-style: normal; font-weight: 600; font-variant-numeric: tabular-nums; }
.bar-row { margin-top: 10px; }
.bar-head { display: flex; justify-content: space-between; gap: 10px; font-size: 11.5px; }
.bar-head span:last-child { color: var(--dim); white-space: nowrap; }
.bar { height: 6px; border-radius: 3px; background: var(--track); overflow: hidden; margin-top: 5px; }
.bar i { display: block; height: 100%; border-radius: 3px; background: var(--c, transparent); transform-origin: 0 50%; }
/* Bars grow in once, as the tab opens; live figures (the GPU) then redraw them in place. */
#usage.intro .bar i { animation: grow 0.6s var(--ease) both; }
@keyframes grow { from { transform: scaleX(0); } }
.bar-used { color: var(--dim); font-size: 11px; margin-top: 4px; }

/* ---- Mascot: drawn at full size, moved and scaled by transform only ---- */
#mascot { position: absolute; top: 0; left: 0; width: 56px; height: 56px; z-index: 2; transform-origin: 0 0; will-change: transform; cursor: pointer;
	transition: transform var(--close-ms) var(--close-ease), opacity 0.2s; }
#frame.open #mascot { transition: transform var(--open-ms) var(--open-ease), opacity 0.2s; }
body.tab-usage #frame.open #mascot { opacity: 0; pointer-events: none; }
#mascot svg { width: 100%; height: 100%; overflow: visible; }
#cell { transform-origin: 50% 90%; animation: breathe 3.4s ease-in-out infinite; }
body.phase-working #cell { animation: bob 0.55s ease-in-out infinite alternate; }
#mascot.squish #cell { animation: squish 0.5s var(--open-ease); }
@keyframes breathe { 50% { transform: scale(1.04, 0.97); } }
@keyframes bob { to { transform: translateY(-4px); } }
@keyframes squish { 0% { transform: scale(1); } 30% { transform: scale(1.22, 0.72); } 60% { transform: scale(0.92, 1.1); } 100% { transform: scale(1); } }
.eye { transform-box: fill-box; transform-origin: center; transition: transform 0.07s; }
body.blink .eye { transform: scaleY(0.1); }
.mood { display: none; }
body.mood-idle .m-smile, body.mood-working .m-focus, body.mood-asking .m-o, body.mood-asking .m-brows-up, body.mood-asking .m-q,
body.mood-alarmed .m-wavy, body.mood-alarmed .m-brows-worried, body.mood-alarmed .m-sweat,
body.mood-happy .m-grin, body.mood-happy .m-happy-eyes, body.mood-sleepy .m-closed, body.mood-sleepy .m-smile, body.mood-sleepy .m-z { display: inline; }
body.mood-happy .eyes, body.mood-sleepy .eyes { display: none; }
.m-z { animation: float 2.4s ease-in-out infinite; }
@keyframes float { 0% { opacity: 0; transform: translate(0, 4px); } 40% { opacity: 1; } 100% { opacity: 0; transform: translate(6px, -10px); } }

@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition-duration: 0.01ms !important; } }
</style>
</head>
<body class="boot mood-idle phase-idle tab-home side-none">
<div id="frame">
	<div id="shadow"></div>
	<div class="shoulder" id="shoulder-l"></div>
	<div class="shoulder" id="shoulder-r"></div>
	<div id="island">
	<div id="mascot">
		<svg viewBox="0 0 100 100" aria-hidden="true">
			<defs>
				<linearGradient id="honey" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd772"/><stop offset="1" stop-color="#f29a16"/></linearGradient>
				<radialGradient id="shine" cx="0.35" cy="0.3" r="0.6"><stop offset="0" stop-color="#fff" stop-opacity="0.55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
			</defs>
			<g id="cell">
				<polygon points="90,57 70,91.6 30,91.6 10,57 30,22.4 70,22.4" fill="#c9740f" stroke="#c9740f" stroke-width="14" stroke-linejoin="round"/>
				<polygon points="90,54 70,88.6 30,88.6 10,54 30,19.4 70,19.4" fill="url(#honey)" stroke="url(#honey)" stroke-width="14" stroke-linejoin="round"/>
				<polygon points="80,52 64,78 36,78 20,52 36,26 64,26" fill="url(#shine)" opacity="0.7"/>
				<circle cx="26" cy="66" r="6" fill="#ff8a65" opacity="0.35"/><circle cx="74" cy="66" r="6" fill="#ff8a65" opacity="0.35"/>
				<g class="eyes">
					<g class="eye"><ellipse cx="37" cy="52" rx="9" ry="11" fill="#fff"/><g class="pupil"><circle cx="37" cy="53" r="5.2" fill="#24170a"/><circle cx="35" cy="50.5" r="1.7" fill="#fff"/></g></g>
					<g class="eye"><ellipse cx="63" cy="52" rx="9" ry="11" fill="#fff"/><g class="pupil"><circle cx="63" cy="53" r="5.2" fill="#24170a"/><circle cx="61" cy="50.5" r="1.7" fill="#fff"/></g></g>
				</g>
				<path class="mood m-happy-eyes" d="M29 54 Q37 44 45 54 M55 54 Q63 44 71 54" stroke="#24170a" stroke-width="3.5" fill="none" stroke-linecap="round"/>
				<path class="mood m-closed" d="M29 54 Q37 59 45 54 M55 54 Q63 59 71 54" stroke="#24170a" stroke-width="3.5" fill="none" stroke-linecap="round"/>
				<path class="mood m-brows-up" d="M28 36 Q37 30 45 35 M55 35 Q63 30 72 36" stroke="#8a4b06" stroke-width="3" fill="none" stroke-linecap="round"/>
				<path class="mood m-brows-worried" d="M29 38 L45 34 M55 34 L71 38" stroke="#8a4b06" stroke-width="3" fill="none" stroke-linecap="round"/>
				<path class="mood m-smile" d="M43 70 Q50 76 57 70" stroke="#5a3208" stroke-width="3.2" fill="none" stroke-linecap="round"/>
				<path class="mood m-focus" d="M45 72 L55 72" stroke="#5a3208" stroke-width="3.2" stroke-linecap="round"/>
				<ellipse class="mood m-o" cx="50" cy="72" rx="4" ry="4.8" fill="#5a3208"/>
				<path class="mood m-wavy" d="M41 73 Q45.5 69 50 73 T59 73" stroke="#5a3208" stroke-width="3.2" fill="none" stroke-linecap="round"/>
				<path class="mood m-grin" d="M40 67 Q50 81 60 67 Z" fill="#5a3208"/>
				<path class="mood m-sweat" d="M84 30 Q90 40 84 44 Q78 40 84 30 Z" fill="#7cc8ff"/>
				<text class="mood m-q" x="84" y="22" font-size="26" font-weight="800" fill="#ffd166" font-family="-apple-system, sans-serif">?</text>
				<text class="mood m-z" x="78" y="24" font-size="20" font-weight="800" fill="#fff" font-family="-apple-system, sans-serif">z</text>
			</g>
		</svg>
	</div>
	<div id="right-ear">
		<svg id="mini" class="mini" viewBox="0 0 20 20"><circle class="t" cx="10" cy="10" r="7.5"/><circle class="v" cx="10" cy="10" r="7.5" stroke-dasharray="47.12" style="stroke-dashoffset: 47.12"/></svg>
		<div id="ear-spinner"></div>
		<div id="ear-ask"></div>
	</div>
	<div id="bar">
		<div class="group">
			<button class="pill active" id="tab-home"><svg viewBox="0 0 24 24"><path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1z"/></svg></button>
			<button class="pill" id="tab-usage"><svg viewBox="0 0 24 24"><path d="M4.5 16.5a8 8 0 1 1 15 0"/><path d="M12 13.5l3.5-4"/><circle cx="12" cy="14" r="1.2"/></svg></button>
		</div>
		<div class="group">
			<button class="pill" id="btn-settings"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></button>
			<button class="pill" id="btn-open"><svg viewBox="0 0 24 24"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg></button>
		</div>
	</div>
	<div id="panel">
		<div id="home">
			<div class="card" id="agent">
				<div id="mascot-slot"></div>
				<div id="name"></div>
				<div class="chip"><i></i><span id="chip-text"></span></div>
				<ul id="steps"></ul>
				<div id="empty-steps"></div>
			</div>
			<div class="card" id="side">
				<div class="side-view" id="tiles-view"><div id="tiles"></div><div id="more"></div></div>
				<div class="side-view" id="ask"><div id="ask-title"></div><div id="ask-cmd"><div id="ask-cmd-text"></div></div><div id="ask-buttons"></div></div>
				<div class="side-view" id="limit"><div id="limit-title"></div><div id="limit-sub"></div></div>
				<div class="side-view note" id="none"></div>
			</div>
		</div>
		<div id="usage"></div>
	</div>
	</div>
</div>
<script>
(function () {
	var frame = document.getElementById('frame');
	var island = document.getElementById('island');
	var shadow = document.getElementById('shadow');
	var shoulderL = document.getElementById('shoulder-l');
	var shoulderR = document.getElementById('shoulder-r');
	var mascot = document.getElementById('mascot');
	var rightEar = document.getElementById('right-ear');
	var panel = document.getElementById('panel');
	var body = document.body;
	var SVGNS = 'http://www.w3.org/2000/svg';
	var CIRC = 2 * Math.PI * 7.5;
	var W = 600, EAR = 36, MASCOT = 56, EAR_MASCOT = 22;
	var geo = { nw: 156, nh: 28, openH: 200 };
	var state = null, tab = 'home', isOpen = false;
	var inside = false, hover = false, collapseTimer = 0, lastPhase = 'idle', lastEventAt = Date.now();
	var shown = {};

	function post(message) { console.info('${NOTCH_MESSAGE_PREFIX}' + JSON.stringify(message)); }
	function $(id) { return document.getElementById(id); }
	function el(tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; } if (text !== undefined && text !== null) { e.textContent = String(text); } return e; }
	function label(key, arg) { var s = (state && state.labels && state.labels[key]) || ''; return arg === undefined ? s : s.replace('{0}', arg); }
	function pct(p) { return typeof p === 'number' ? Math.round(p) + '%' : '\\u2014'; }
	function setClass(prefix, value) {
		var keep = body.className.split(' ').filter(function (c) { return c && c.indexOf(prefix + '-') !== 0; });
		keep.push(prefix + '-' + value);
		body.className = keep.join(' ');
	}
	/** True when \`value\` differs from what \`key\` last rendered: only changed sections are touched. */
	function changed(key, value) { var j = JSON.stringify(value); if (shown[key] === j) { return false; } shown[key] = j; return true; }
	function dash(percent) { return String(CIRC * (1 - Math.min(100, Math.max(0, percent || 0)) / 100)); }

	// ---- Springs: a damped harmonic oscillator, sampled into a CSS linear() easing ----
	function spring(response, damping) {
		var w0 = 2 * Math.PI / response, z = damping, wd = w0 * Math.sqrt(Math.max(1e-4, 1 - z * z));
		function x(t) {
			var e = Math.exp(-z * w0 * t);
			return z < 1 ? 1 - e * (Math.cos(wd * t) + (z * w0 / wd) * Math.sin(wd * t)) : 1 - e * (1 + w0 * t);
		}
		var end = 0;
		for (var t = 0; t < 3; t += 0.005) { if (Math.abs(1 - x(t)) > 0.002) { end = t; } }
		end = Math.max(0.15, end + 0.01);
		var points = [];
		for (var i = 0; i <= 48; i++) { points.push(i === 48 ? '1' : x(end * i / 48).toFixed(4)); }
		return { ease: 'linear(' + points.join(', ') + ')', ms: Math.round(end * 1000) + 'ms' };
	}
	(function () {
		var open = spring(0.46, 0.78), close = spring(0.3, 1);
		var root = document.documentElement.style;
		if (CSS.supports('transition-timing-function', open.ease)) {
			root.setProperty('--open-ease', open.ease); root.setProperty('--open-ms', open.ms);
			root.setProperty('--close-ease', close.ease); root.setProperty('--close-ms', close.ms);
		}
	})();

	// ---- Geometry: the island's clip, the shoulders, the mascot and the ear ----
	function layout() {
		var wc = geo.nw + 2 * EAR, band = Math.max(geo.nh, 32), H = innerHeight;
		var w = isOpen ? W : wc, h = isOpen ? geo.openH : geo.nh, r = isOpen ? 30 : 13, side = (W - w) / 2, foldSide = (W - wc) / 2;
		island.style.clipPath = 'inset(0px ' + side + 'px ' + Math.max(0, H - h) + 'px ' + side + 'px round 0px 0px ' + r + 'px ' + r + 'px)';
		shoulderL.style.transform = 'translateX(' + (side - 12) + 'px)';
		shoulderR.style.transform = 'translateX(' + (W - side) + 'px)';
		shadow.style.height = geo.openH + 'px';
		document.documentElement.style.setProperty('--band', band + 'px');
		mascot.style.transform = isOpen
			? 'translate(27px, ' + (band + 21) + 'px) scale(1)'
			: 'translate(' + (foldSide + EAR / 2 - EAR_MASCOT / 2) + 'px, ' + (geo.nh / 2 - EAR_MASCOT / 2) + 'px) scale(' + (EAR_MASCOT / MASCOT) + ')';
		rightEar.style.left = (foldSide + wc - EAR) + 'px';
		rightEar.style.width = EAR + 'px';
		rightEar.style.height = geo.nh + 'px';
		box = null;
	}
	/** Where the pointer counts as over the island, in window coordinates. */
	function hitRect() {
		var wc = geo.nw + 2 * EAR, w = isOpen ? W : wc, left = (innerWidth - W) / 2 + (W - w) / 2;
		return { left: left - 4, right: left + w + 4, top: 0, bottom: (isOpen ? geo.openH : geo.nh) + 2 };
	}
	function setOpen(open) {
		if (open === isOpen) { return; }
		isOpen = open;
		frame.classList.toggle('open', open);
		layout();
	}
	new ResizeObserver(function () {
		var h = panel.offsetTop + panel.offsetHeight + 12;
		if (Math.abs(h - geo.openH) > 0.5) { geo.openH = h; layout(); }
	}).observe(panel);
	function wantsOpen() { return hover || !!(state && state.permission); }

	function mood() {
		if (!state) { return 'idle'; }
		if (state.phase === 'asking') { return 'asking'; }
		var w = worst(state.rings || []);
		if (w && w.severity === 'critical') { return 'alarmed'; }
		if (state.phase === 'working') { return 'working'; }
		if (state.phase === 'done') { return 'happy'; }
		if (!hover && Date.now() - lastEventAt > 10 * 60 * 1000) { return 'sleepy'; }
		return 'idle';
	}
	var ORDER = ['unknown', 'ok', 'elevated', 'high', 'critical'];
	function worst(rings) {
		var w = null;
		rings.forEach(function (r) { if (!w || ORDER.indexOf(r.severity) > ORDER.indexOf(w.severity) || (r.severity === w.severity && (r.percent || 0) > (w.percent || 0))) { w = r; } });
		return w;
	}
	/** Your own assistant out of its limit. A backup provider on hold stays a red tile: it must not cover the rings for its whole cooldown. */
	function exhausted(rings) {
		for (var i = 0; i < rings.length; i++) {
			// Only plan limits: a model 100% in GPU memory or a busy GPU is not a limit.
			if (rings[i].id.indexOf('backup:') === 0 || rings[i].id === 'local' || rings[i].id === 'gpu') { continue; }
			var ws = rings[i].windows || [];
			for (var j = 0; j < ws.length; j++) { if (ws[j].exhausted || (ws[j].percent || 0) >= 100) { return { ring: rings[i], win: ws[j] }; } }
		}
		return null;
	}

	// ---- Pieces ----
	function makeDial() {
		var dial = el('div', 'dial');
		var svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('viewBox', '0 0 20 20');
		var t = document.createElementNS(SVGNS, 'circle'), v = document.createElementNS(SVGNS, 'circle');
		[t, v].forEach(function (c, i) { c.setAttribute('class', i ? 'v' : 't'); c.setAttribute('cx', '10'); c.setAttribute('cy', '10'); c.setAttribute('r', '7.5'); svg.appendChild(c); });
		v.setAttribute('stroke-dasharray', String(CIRC)); v.style.strokeDashoffset = String(CIRC);
		var glyph = el('span', 'glyph');
		dial.appendChild(svg); dial.appendChild(glyph);
		return { root: dial, v: v, glyph: glyph };
	}
	function stepIcon(status) {
		if (status === 'in_progress' && state.phase === 'working') { return el('span', 'si run'); }
		var svg = document.createElementNS(SVGNS, 'svg'); svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('class', 'si');
		var paths = status === 'completed' ? ['<circle cx="8" cy="8" r="7" fill="#30d158"/>', '<path d="M4.8 8.3l2.1 2.1 4.3-4.6" stroke="#000" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>']
			: status === 'failed' ? ['<circle cx="8" cy="8" r="7" fill="#ff453a"/>', '<path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="#000" stroke-width="1.8" stroke-linecap="round"/>']
			: ['<circle cx="8" cy="8" r="6.2" fill="none" stroke="rgba(235,235,245,0.3)" stroke-width="1.5"/>'];
		svg.innerHTML = paths.join(''); // static markup, no data
		return svg;
	}

	// ---- Rendering: each section only when its input changed ----
	var tileEls = {};
	function renderTiles(rings) {
		var tiles = $('tiles'), seen = {};
		rings.slice(0, 3).forEach(function (r) {
			var t = tileEls[r.id];
			if (!t) {
				var dial = makeDial();
				t = { root: el('div', 'tile'), dial: dial, pct: el('div', 'pct'), nm: el('div', 'nm'), rs: el('div', 'rs') };
				t.root.appendChild(dial.root); t.root.appendChild(t.pct); t.root.appendChild(t.nm); t.root.appendChild(t.rs);
				t.root.addEventListener('click', function () { showUsage(); });
				tileEls[r.id] = t;
			}
			var fullest = (r.windows || []).reduce(function (a, b) { return !a || (b.percent || 0) > (a.percent || 0) ? b : a; }, null);
			t.root.className = 'tile sev-' + r.severity;
			t.dial.v.style.strokeDashoffset = dash(r.percent);
			t.dial.glyph.textContent = r.glyph;
			t.pct.textContent = pct(r.percent);
			t.nm.textContent = r.label;
			// Tiles are narrow: for a plan, the reset of the fullest window says enough; the local model and GPU tiles carry their own summary.
			t.rs.textContent = r.id === 'local' || r.id === 'gpu' ? r.detail : (fullest && fullest.reset) || r.detail;
			t.root.title = r.label + ' \\u00b7 ' + r.detail;
			tiles.appendChild(t.root);
			seen[r.id] = true;
		});
		Object.keys(tileEls).forEach(function (id) { if (!seen[id]) { tileEls[id].root.remove(); delete tileEls[id]; } });
		$('more').textContent = rings.length > 3 ? label('more', rings.length - 3) : '';
	}

	function renderUsage(rings) {
		var usage = $('usage'); usage.textContent = '';
		if (!rings.length) { usage.appendChild(el('div', 'card note', label('noUsage'))); }
		rings.forEach(function (r) {
			var c = el('div', 'card prov');
			var head = el('div', 'prov-head sev-' + r.severity);
			var dial = makeDial(); dial.glyph.textContent = r.glyph; dial.v.style.strokeDashoffset = dash(r.percent);
			head.appendChild(dial.root); head.appendChild(el('b', '', r.label)); head.appendChild(el('em', '', pct(r.percent)));
			c.appendChild(head);
			var ws = r.windows || [];
			if (!ws.length) { c.appendChild(el('div', 'bar-used', r.detail)); }
			ws.forEach(function (wnd) {
				var row = el('div', 'bar-row sev-' + wnd.severity);
				var bh = el('div', 'bar-head'); bh.appendChild(el('span', '', wnd.label)); bh.appendChild(el('span', '', wnd.reset || ''));
				var bar = el('div', 'bar'); var fill = el('i'); fill.style.width = Math.min(100, Math.max(0, wnd.percent || 0)) + '%'; bar.appendChild(fill);
				row.appendChild(bh); row.appendChild(bar); row.appendChild(el('div', 'bar-used', label('used', pct(wnd.percent))));
				c.appendChild(row);
			});
			usage.appendChild(c);
		});
	}

	function render() {
		if (!state || !state.notch || !state.labels) { return; }
		var rings = state.rings || [], steps = state.steps || [];
		if (state.notch.width !== geo.nw || state.notch.height !== geo.nh) { geo.nw = state.notch.width; geo.nh = state.notch.height; layout(); }
		if (state.phase !== lastPhase && (state.phase === 'working' || state.phase === 'asking')) { lastEventAt = Date.now(); }
		lastPhase = state.phase;
		setClass('phase', state.phase);
		setClass('mood', mood());
		setClass('tab', tab);

		if (changed('labels', [tab, state.labels])) {
			$('tab-home').classList.toggle('active', tab === 'home');
			$('tab-usage').classList.toggle('active', tab === 'usage');
			$('tab-home').title = label('home'); $('tab-usage').title = label('usage'); $('btn-settings').title = label('settings'); $('btn-open').title = label('open');
		}

		// Right ear: the most urgent ring.
		var w = worst(rings), mini = $('mini');
		mini.setAttribute('class', 'mini sev-' + (w ? w.severity : 'unknown'));
		mini.querySelector('.v').style.strokeDashoffset = dash(w && w.percent);

		// Agent card.
		if (changed('agent', [state.agent, state.route, state.phase, steps])) {
			$('name').textContent = state.agent || label('hivemind');
			$('chip-text').textContent = label(state.phase) + (state.route ? ' \\u00b7 ' + state.route : '');
			var list = $('steps'), existing = list.children.length;
			list.textContent = '';
			steps.forEach(function (s, i) {
				var li = el('li', s.status); li.appendChild(stepIcon(s.status)); li.appendChild(el('span', '', s.title));
				// Only a new step slides in; the ones already shown stay put.
				if (i < existing) { li.style.animation = 'none'; }
				list.appendChild(li);
			});
			if (state.phase === 'done' && steps.length) {
				var done = el('li', 'completed'); done.appendChild(stepIcon('completed')); done.appendChild(el('span', '', label('done'))); list.appendChild(done);
			}
			$('empty-steps').textContent = steps.length || state.agent ? '' : label('noRun');
		}

		// Side card: ask > limit > tiles.
		var p = state.permission, hit = exhausted(rings);
		setClass('side', p ? 'ask' : hit ? 'limit' : rings.length ? 'tiles' : 'none');
		if (p && changed('ask', p)) {
			$('ask-title').textContent = p.heading;
			$('ask-cmd-text').textContent = p.command;
			var buttons = $('ask-buttons'); buttons.textContent = '';
			(p.options || []).forEach(function (o) {
				var b = el('button', o.kind === 'allow_once' ? 'primary' : o.kind.indexOf('reject') === 0 ? 'ghost' : '', o.name);
				b.title = o.name;
				b.addEventListener('click', function (e) { e.stopPropagation(); post({ type: 'permission', id: p.id, optionId: o.optionId }); });
				buttons.appendChild(b);
			});
		}
		if (hit && changed('limit', [hit.ring.label, hit.win.reset, hit.win.label])) {
			$('limit-title').textContent = label('limitReached', hit.ring.label);
			$('limit-sub').textContent = hit.win.reset || hit.win.label;
		}
		if (changed('tiles', rings)) { renderTiles(rings); }
		$('none').textContent = label('noUsage');
		if (changed('usage', rings)) { renderUsage(rings); }

		setOpen(wantsOpen());
	}

	// ---- Pointer: the window is click-through except over the island ----
	function onMove(x, y) {
		var r = hitRect();
		var now = x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
		if (now !== inside) { inside = now; post({ type: 'hover', inside: inside }); }
		if (inside) {
			clearTimeout(collapseTimer); collapseTimer = 0;
			if (!hover) { hover = true; setClass('mood', mood()); setOpen(true); }
		} else if (hover && !collapseTimer) {
			collapseTimer = setTimeout(function () {
				collapseTimer = 0;
				if (!inside) { hover = false; tab = 'home'; render(); if (!state) { setOpen(false); } }
			}, 220);
		}
	}
	document.addEventListener('mousemove', function (e) { onMove(e.clientX, e.clientY); });
	document.addEventListener('mouseleave', function () { onMove(-1000, -1000); });

	mascot.addEventListener('click', function (e) {
		e.stopPropagation();
		mascot.classList.remove('squish'); void mascot.offsetWidth; mascot.classList.add('squish');
		post({ type: 'focus' });
	});
	$('agent').addEventListener('click', function () { post({ type: 'focus' }); });
	$('tab-home').addEventListener('click', function () { tab = 'home'; render(); });
	var introTimer = 0;
	function showUsage() {
		tab = 'usage';
		var usage = $('usage');
		usage.classList.add('intro'); clearTimeout(introTimer);
		introTimer = setTimeout(function () { usage.classList.remove('intro'); }, 700);
		render();
	}
	$('tab-usage').addEventListener('click', showUsage);
	$('btn-settings').addEventListener('click', function () { post({ type: 'settings' }); });
	$('btn-open').addEventListener('click', function () { post({ type: 'focus' }); });

	// ---- Eyes: cursor samples arrive ~30 times a second; the pupils glide every frame ----
	var pupils = Array.prototype.slice.call(document.querySelectorAll('.pupil'));
	var target = [[0, 0], [0, 0]], current = [[0, 0], [0, 0]], gliding = false;
	// The mascot's position, measured at most every 250ms: measuring after every pupil move would force a layout.
	var box = null, boxAt = 0;
	function glide() {
		var moving = false;
		for (var i = 0; i < 2; i++) {
			for (var k = 0; k < 2; k++) {
				var d = target[i][k] - current[i][k];
				if (Math.abs(d) > 0.02) { current[i][k] += d * 0.28; moving = true; } else { current[i][k] = target[i][k]; }
			}
			pupils[i].style.transform = 'translate(' + current[i][0].toFixed(2) + 'px,' + current[i][1].toFixed(2) + 'px)';
		}
		gliding = moving;
		if (moving) { requestAnimationFrame(glide); }
	}
	window.__notchCursor = function (x, y) {
		if (x >= 0 && y >= 0 && x < innerWidth && y < innerHeight) { onMove(x, y); }
		var now = Date.now();
		if (!box || now - boxAt > 250) { box = mascot.getBoundingClientRect(); boxAt = now; }
		for (var i = 0; i < 2; i++) {
			var cx = box.left + box.width * (i ? 0.63 : 0.37), cy = box.top + box.height * 0.53;
			var dx = x - cx, dy = y - cy, d = Math.sqrt(dx * dx + dy * dy) || 1;
			var reach = Math.min(1, d / 80) * 3.6;
			target[i] = [dx / d * reach, dy / d * reach];
		}
		if (!gliding) { gliding = true; requestAnimationFrame(glide); }
	};

	// ---- Blinking ----
	(function blink() {
		setTimeout(function () {
			body.classList.add('blink');
			setTimeout(function () { body.classList.remove('blink'); blink(); }, 130);
		}, 2400 + Math.random() * 3800);
	})();
	setInterval(function () { if (state) { setClass('mood', mood()); } }, 30 * 1000);

	window.__notch = function (next) { state = next; render(); };
	layout();
	// First frame without transitions, so the notch does not animate in from nowhere.
	requestAnimationFrame(function () { requestAnimationFrame(function () { body.classList.remove('boot'); }); });
	post({ type: 'ready' });
})();
</script>
</body>
</html>`;
