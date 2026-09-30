#!/usr/bin/env python3
"""Generates the Hivemind color themes (one per lens, plus Light) from one palette."""
import json
import os

# Run from anywhere: python3 extensions/theme-hivemind/build/generate-themes.py
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'themes')

# The matte body every dark variant shares: one black surface, hairline
# borders, greyscale text. Lenses below only supply the accent.
MATTE = dict(
	type='dark',
	bg='#0b0b0b', surface='#111111', raised='#171717', select='#1d1d1d',
	border='#1a1a1a', borderStrong='#262626',
	fg='#c9c9c9', bright='#f4f4f4', muted='#7a7a7a', faint='#474747', ghost='#262626',
	onAccent='#0b0b0b', buttonFg='#0b0b0b',
	yellow='#e8c46a', blue='#8aa4c8', purple='#b49ad8', cyan='#7fc8c0', orange='#e89a5a',
	selectionInactive='#ffffff12', lineHighlight='#ffffff05', wordHighlight='#ffffff14',
	shadow='#00000099', scrollbar='#ffffff14', scrollbarHover='#ffffff22', scrollbarActive='#ffffff30',
	syntax=dict(
		comment='#4d4d4d', keyword='#f4f4f4',
		function='#e6e6e6', type='#d4d4d4', variable='#b3b3b3', property='#949494',
		punctuation='#5f5f5f', operator='#8c8c8c', tag='#f4f4f4', attribute='#8c8c8c',
	),
	ansi=dict(
		black='#0b0b0b', blue='#8aa4c8', magenta='#b49ad8', cyan='#7fc8c0', white='#c9c9c9',
		brightBlack='#4d4d4d', brightBlue='#abc0dd', brightMagenta='#cbb8e6', brightCyan='#a3dad4', brightWhite='#f4f4f4',
	),
)


def lens(base, **overrides):
	"""Base palette with a lens applied; syntax and ansi merge rather than replace."""
	p = {**base, **overrides}
	p['syntax'] = {**base['syntax'], **overrides.get('syntax', {})}
	p['ansi'] = {**base['ansi'], **overrides.get('ansi', {})}
	return p


# Dynamic, the default: every lens at once, Catppuccin-style. Each kind of
# code owns one lens color — imports lilac, declarations violet, control flow
# ember red, functions cobalt, types gold, strings lime, numbers orange,
# escapes jade, operators ice. The chrome keeps a single accent (the Ember
# lens) so the workbench stays calm while the code carries the color.
DYNAMIC = lens(
	MATTE,
	name='Hivemind Dynamic',
	visor=('#ff3b2f', '#ff7a1a', '#ffc53d'),
	beam=('#ff7a1a', '#b8ff3c', '#3d9bff', '#a86bff', '#e6e6e6'),  # Ember, Jade, Cobalt, Violet, Chrome
	accent='#ff7a1a', accentText='#ff8f3f',
	button='#ff7a1a', buttonHover='#ff9447',
	red='#ff4f6d', yellow='#ffc53d', blue='#5aabff', purple='#b98aff', cyan='#2ee6a6', orange='#ff8f3f',
	selection='#ff7a1a26', findMatch='#ff7a1a55', findMatchHighlight='#ff7a1a22',
	added='#8fd694', addedBg='#8fd69414', addedText='#8fd6942a',
	removed='#ff4f6d', removedBg='#ff4f6d12', removedText='#ff4f6d2a',
	syntax=dict(
		keyword='#b98aff', module='#e0a8ff', control='#ff6b5a', self='#ff6b5a',
		function='#5aabff', type='#ffc53d', decorator='#ffc53d',
		string='#b8e86a', constant='#ff8f3f', escape='#2ee6a6', regex='#2ee6a6',
		operator='#8fd8ff', property='#a8c8f0', parameter='#f5b98a', variable='#d4d4d4',
		tag='#b98aff', attribute='#ffc53d', invalid='#ff4f6d',
	),
	ansi=dict(
		red='#ff4f6d', green='#b8e86a', yellow='#ffc53d', blue='#5aabff', magenta='#b98aff', cyan='#2ee6a6',
		brightRed='#ff7a8f', brightGreen='#d0f09a', brightYellow='#ffd774', brightBlue='#8fc4ff', brightMagenta='#d0b0ff', brightCyan='#7af0c6',
	),
)

# Each lens is one hue family, never a blend: its gradient runs dark to light
# within that hue, and the same hue carries buttons, cursor and code highlights.
# Errors and additions pick colors outside the lens so neither reads as accent.

# Ember: a mirrored ruby lens, red through orange to gold.
EMBER = lens(
	MATTE,
	name='Hivemind Ember',
	visor=('#ff3b2f', '#ff7a1a', '#ffc53d'),
	accent='#ff7a1a', accentText='#ff8f3f',
	button='#ff7a1a', buttonHover='#ff9447',
	red='#ff4f6d',
	selection='#ff7a1a26', findMatch='#ff7a1a55', findMatchHighlight='#ff7a1a22',
	added='#8fd694', addedBg='#8fd69414', addedText='#8fd6942a',
	removed='#ff4f6d', removedBg='#ff4f6d12', removedText='#ff4f6d2a',
	syntax=dict(string='#f5c46b', constant='#ff8f3f', escape='#ff5a3d', regex='#ffc53d', invalid='#ff4f6d'),
	ansi=dict(
		red='#ff4f6d', green='#8fd694', yellow='#ffc53d',
		brightRed='#ff7a8f', brightGreen='#b0e6b3', brightYellow='#ffd774',
	),
)

# Jade: an iridescent green lens, teal through lime to a yellow edge.
JADE = lens(
	MATTE,
	name='Hivemind Jade',
	visor=('#2ee6a6', '#b8ff3c', '#f2ee4f'),
	accent='#b8ff3c', accentText='#b8ff3c',
	button='#b8ff3c', buttonHover='#c9ff66',
	red='#ff5c5c',
	selection='#b8ff3c24', findMatch='#b8ff3c55', findMatchHighlight='#b8ff3c22',
	added='#b8ff3c', addedBg='#b8ff3c14', addedText='#b8ff3c2a',
	removed='#ff5c5c', removedBg='#ff5c5c12', removedText='#ff5c5c2a',
	syntax=dict(string='#bde66f', constant='#b8ff3c', escape='#2ee6a6', regex='#e8c46a', invalid='#ff5c5c'),
	ansi=dict(
		red='#ff5c5c', green='#b8ff3c', yellow='#e8c46a',
		brightRed='#ff8080', brightGreen='#d4ff85', brightYellow='#f2d690',
	),
)

# Cobalt: an ice-blue lens, deep cobalt to a pale sky edge.
COBALT = lens(
	MATTE,
	name='Hivemind Cobalt',
	visor=('#2b6bff', '#3d9bff', '#8fd8ff'),
	accent='#3d9bff', accentText='#5aabff',
	button='#3d9bff', buttonHover='#63b0ff',
	red='#ff5c5c',
	selection='#3d9bff26', findMatch='#3d9bff55', findMatchHighlight='#3d9bff22',
	added='#8fd694', addedBg='#8fd69414', addedText='#8fd6942a',
	removed='#ff5c5c', removedBg='#ff5c5c12', removedText='#ff5c5c2a',
	syntax=dict(string='#9fd4ff', constant='#5aabff', escape='#6f8cff', regex='#8fd8ff', invalid='#ff5c5c'),
	ansi=dict(
		red='#ff5c5c', green='#8fd694', yellow='#e8c46a',
		brightRed='#ff8080', brightGreen='#b0e6b3', brightYellow='#f2d690',
	),
)

# Violet: an ultraviolet lens, deep violet to a pale lilac edge.
VIOLET = lens(
	MATTE,
	name='Hivemind Violet',
	visor=('#7b3cff', '#a86bff', '#e0a8ff'),
	accent='#a86bff', accentText='#b98aff',
	button='#a86bff', buttonHover='#bb8cff',
	red='#ff5c5c',
	selection='#a86bff26', findMatch='#a86bff55', findMatchHighlight='#a86bff22',
	added='#8fd694', addedBg='#8fd69414', addedText='#8fd6942a',
	removed='#ff5c5c', removedBg='#ff5c5c12', removedText='#ff5c5c2a',
	syntax=dict(string='#d9b8ff', constant='#b98aff', escape='#9a70ff', regex='#e0a8ff', invalid='#ff5c5c'),
	ansi=dict(
		red='#ff5c5c', green='#8fd694', yellow='#e8c46a',
		brightRed='#ff8080', brightGreen='#b0e6b3', brightYellow='#f2d690',
	),
)

# Chrome: a clear mirrored lens with no tint, graphite to white. The most
# minimal lens; code highlights are brightness steps, not hues.
CHROME = lens(
	MATTE,
	name='Hivemind Chrome',
	visor=('#6e6e6e', '#d9d9d9', '#ffffff'),
	accent='#e6e6e6', accentText='#ffffff',
	button='#e6e6e6', buttonHover='#ffffff',
	red='#ff5c5c',
	selection='#ffffff1f', findMatch='#ffffff40', findMatchHighlight='#ffffff1a',
	added='#8fd694', addedBg='#8fd69414', addedText='#8fd6942a',
	removed='#ff5c5c', removedBg='#ff5c5c12', removedText='#ff5c5c2a',
	syntax=dict(string='#d9d9d9', constant='#ffffff', escape='#a0a0a0', regex='#cfcfcf', invalid='#ff5c5c'),
	ansi=dict(
		red='#ff5c5c', green='#8fd694', yellow='#e8c46a',
		brightRed='#ff8080', brightGreen='#b0e6b3', brightYellow='#f2d690',
	),
)

# Hivemind Light: the light counterpart of Dynamic — the same role-per-lens
# mapping in deep tones that hold contrast on white, with a deepened Ember lens
# on the chrome. The bright gradient only fills surfaces that carry black text.
LIGHT = dict(
	name='Hivemind Light', type='light',
	visor=('#e0341f', '#f26b0f', '#f2a900'),
	beam=('#f26b0f', '#4a8a00', '#2b6bff', '#7b3cff', '#6e6e6e'),
	bg='#f5f5f3', surface='#ffffff', raised='#ececea', select='#e3e3e0',
	border='#e4e4e1', borderStrong='#d0d0cc',
	fg='#262626', bright='#0b0b0b', muted='#6b6b6b', faint='#a6a6a6', ghost='#dcdcd8',
	accent='#d9540a', accentText='#b8430a', onAccent='#0b0b0b',
	button='#f26b0f', buttonFg='#0b0b0b', buttonHover='#f5802f',
	red='#d42e4f', yellow='#a67c00', blue='#3e6a9e', purple='#7a55b0', cyan='#2e8a80', orange='#c0621e',
	selection='#f26b0f24', selectionInactive='#0000000f', lineHighlight='#00000006',
	findMatch='#f26b0f4d', findMatchHighlight='#f26b0f1f', wordHighlight='#00000012',
	added='#3f8a3a', addedBg='#3f8a3a12', addedText='#3f8a3a26',
	removed='#d42e4f', removedBg='#d42e4f10', removedText='#d42e4f26',
	shadow='#00000026', scrollbar='#00000014', scrollbarHover='#00000022', scrollbarActive='#00000030',
	syntax=dict(
		comment='#a6a6a6', keyword='#7a3cc8', module='#9a4fd6', control='#c8321f', self='#c8321f',
		function='#1f5fd6', type='#8a6100', decorator='#8a6100',
		string='#3f7a12', constant='#c2410c', escape='#0f8a66', regex='#0f8a66',
		operator='#2e7fa8', property='#3e6a9e', parameter='#a8552a', variable='#2e2e2e',
		punctuation='#9a9a9a', tag='#7a3cc8', attribute='#8a6100', invalid='#d42e4f',
	),
	ansi=dict(
		black='#0b0b0b', red='#d42e4f', green='#3f8a3a', yellow='#a67c00', blue='#3e6a9e',
		magenta='#7a55b0', cyan='#2e8a80', white='#d0d0cc',
		brightBlack='#6b6b6b', brightRed='#e05a74', brightGreen='#56a650', brightYellow='#c29a1f',
		brightBlue='#5a86ba', brightMagenta='#9573c8', brightCyan='#45a89d', brightWhite='#f5f5f3',
	),
)

def colors(p):
	T = '#00000000'
	c = {
		# base
		'foreground': p['fg'],
		'disabledForeground': p['faint'],
		'descriptionForeground': p['muted'],
		'errorForeground': p['red'],
		'icon.foreground': p['muted'],
		'focusBorder': p['accent'] + '80',
		'contrastBorder': T,
		'selection.background': p['selection'],
		'widget.border': p['borderStrong'],
		'widget.shadow': p['shadow'],
		'scrollbar.shadow': T,
		'sash.hoverBorder': p['accent'],
		'textLink.foreground': p['accentText'],
		'textLink.activeForeground': p['accentText'],
		'textBlockQuote.background': p['surface'],
		'textBlockQuote.border': p['borderStrong'],
		'textCodeBlock.background': p['surface'],
		'textPreformat.background': p['raised'],
		'textPreformat.foreground': p['bright'],
		'textSeparator.foreground': p['border'],
		'toolbar.hoverBackground': p['raised'],
		'toolbar.activeBackground': p['select'],

		# buttons & controls
		'button.background': p['button'],
		'button.foreground': p['buttonFg'],
		'button.hoverBackground': p['buttonHover'],
		'button.border': T,
		'button.separator': p['buttonFg'] + '40',
		'button.secondaryBackground': p['raised'],
		'button.secondaryForeground': p['fg'],
		'button.secondaryHoverBackground': p['select'],
		'button.secondaryBorder': p['borderStrong'],
		'extensionButton.prominentBackground': p['button'],
		'extensionButton.prominentForeground': p['buttonFg'],
		'extensionButton.prominentHoverBackground': p['buttonHover'],
		'checkbox.background': p['surface'],
		'checkbox.border': p['borderStrong'],
		'checkbox.foreground': p['accentText'],
		'dropdown.background': p['surface'],
		'dropdown.listBackground': p['surface'],
		'dropdown.border': p['borderStrong'],
		'dropdown.foreground': p['fg'],
		'input.background': p['surface'],
		'input.border': p['borderStrong'],
		'input.foreground': p['fg'],
		'input.placeholderForeground': p['faint'],
		'inputOption.activeBackground': p['accent'] + '22',
		'inputOption.activeBorder': p['accent'] + '80',
		'inputOption.activeForeground': p['bright'],
		'inputValidation.errorBackground': p['surface'],
		'inputValidation.errorBorder': p['red'],
		'inputValidation.errorForeground': p['fg'],
		'inputValidation.warningBackground': p['surface'],
		'inputValidation.warningBorder': p['yellow'],
		'inputValidation.warningForeground': p['fg'],
		'inputValidation.infoBackground': p['surface'],
		'inputValidation.infoBorder': p['muted'],
		'inputValidation.infoForeground': p['fg'],
		'keybindingLabel.background': p['raised'],
		'keybindingLabel.foreground': p['fg'],
		'keybindingLabel.border': p['borderStrong'],
		'keybindingLabel.bottomBorder': p['borderStrong'],
		'badge.background': p['button'],
		'badge.foreground': p['buttonFg'],
		'progressBar.background': p['accent'],

		# title / activity / side bar
		'titleBar.activeBackground': p['bg'],
		'titleBar.activeForeground': p['muted'],
		'titleBar.inactiveBackground': p['bg'],
		'titleBar.inactiveForeground': p['faint'],
		'titleBar.border': p['border'],
		'commandCenter.background': p['surface'],
		'commandCenter.foreground': p['muted'],
		'commandCenter.border': p['border'],
		'commandCenter.activeBackground': p['raised'],
		'commandCenter.activeForeground': p['fg'],
		'commandCenter.activeBorder': p['borderStrong'],
		'commandCenter.inactiveBorder': p['border'],
		'activityBar.background': p['bg'],
		'activityBar.foreground': p['bright'],
		'activityBar.inactiveForeground': p['faint'],
		'activityBar.activeBorder': p['accent'],
		'activityBar.activeBackground': T,
		'activityBar.activeFocusBorder': p['accent'],
		'activityBar.border': p['border'],
		'activityBarTop.foreground': p['bright'],
		'activityBarTop.inactiveForeground': p['faint'],
		'activityBarTop.activeBorder': p['accent'],
		'activityBarBadge.background': p['button'],
		'activityBarBadge.foreground': p['buttonFg'],
		'activityErrorBadge.background': p['red'],
		'activityErrorBadge.foreground': p['bg'] if p['type'] == 'dark' else '#ffffff',
		'activityWarningBadge.background': p['yellow'],
		'activityWarningBadge.foreground': p['bg'] if p['type'] == 'dark' else '#ffffff',
		'sideBar.background': p['bg'],
		'sideBar.foreground': p['fg'],
		'sideBar.border': p['border'],
		'sideBarTitle.foreground': p['muted'],
		'sideBarSectionHeader.background': p['bg'],
		'sideBarSectionHeader.foreground': p['muted'],
		'sideBarSectionHeader.border': p['border'],
		'sideBarActivityBarTop.border': p['border'],

		# lists & trees
		'list.activeSelectionBackground': p['select'],
		'list.activeSelectionForeground': p['bright'],
		'list.activeSelectionIconForeground': p['bright'],
		'list.inactiveSelectionBackground': p['raised'],
		'list.inactiveSelectionForeground': p['fg'],
		'list.hoverBackground': p['raised'],
		'list.hoverForeground': p['bright'],
		'list.focusBackground': p['select'],
		'list.focusForeground': p['bright'],
		'list.focusOutline': p['accent'] + '66',
		'list.inactiveFocusOutline': T,
		'list.highlightForeground': p['accentText'],
		'list.focusHighlightForeground': p['accentText'],
		'list.dropBackground': p['accent'] + '1a',
		'list.errorForeground': p['red'],
		'list.warningForeground': p['yellow'],
		'list.invalidItemForeground': p['red'],
		'list.deemphasizedForeground': p['faint'],
		'tree.indentGuidesStroke': p['ghost'],
		'tree.inactiveIndentGuidesStroke': p['ghost'],

		# editor groups & tabs
		'editorGroup.border': p['border'],
		'editorGroup.dropBackground': p['accent'] + '14',
		'editorGroupHeader.tabsBackground': p['bg'],
		'editorGroupHeader.tabsBorder': p['border'],
		'editorGroupHeader.noTabsBackground': p['bg'],
		'tab.activeBackground': p['bg'],
		'tab.activeForeground': p['bright'],
		'tab.activeBorder': p['bg'],
		'tab.activeBorderTop': p['accent'],
		'tab.selectedBorderTop': p['accent'],
		'tab.inactiveBackground': p['bg'],
		'tab.inactiveForeground': p['faint'],
		'tab.hoverBackground': p['surface'],
		'tab.hoverForeground': p['fg'],
		'tab.border': p['border'],
		'tab.lastPinnedBorder': p['borderStrong'],
		'tab.unfocusedActiveBackground': p['bg'],
		'tab.unfocusedActiveForeground': p['muted'],
		'tab.unfocusedActiveBorder': p['bg'],
		'tab.unfocusedActiveBorderTop': p['faint'],
		'tab.unfocusedInactiveBackground': p['bg'],
		'tab.unfocusedInactiveForeground': p['faint'],
		'tab.unfocusedHoverBackground': p['surface'],
		'breadcrumb.background': p['bg'],
		'breadcrumb.foreground': p['faint'],
		'breadcrumb.focusForeground': p['fg'],
		'breadcrumb.activeSelectionForeground': p['bright'],
		'breadcrumbPicker.background': p['surface'],

		# editor
		'editor.background': p['bg'],
		'editor.foreground': p['fg'],
		'editorCursor.foreground': p['accent'],
		'editor.lineHighlightBackground': p['lineHighlight'],
		'editor.lineHighlightBorder': T,
		'editor.selectionBackground': p['selection'],
		'editor.inactiveSelectionBackground': p['selectionInactive'],
		'editor.selectionHighlightBackground': p['wordHighlight'],
		'editor.wordHighlightBackground': p['wordHighlight'],
		'editor.wordHighlightStrongBackground': p['wordHighlight'],
		'editor.findMatchBackground': p['findMatch'],
		'editor.findMatchBorder': p['accent'],
		'editor.findMatchHighlightBackground': p['findMatchHighlight'],
		'editor.findRangeHighlightBackground': p['lineHighlight'],
		'editor.hoverHighlightBackground': p['wordHighlight'],
		'editor.rangeHighlightBackground': p['lineHighlight'],
		'editorLink.activeForeground': p['accentText'],
		'editorLineNumber.foreground': p['faint'] if p['type'] == 'light' else '#363636',
		'editorLineNumber.activeForeground': p['bright'],
		'editorIndentGuide.background1': p['ghost'],
		'editorIndentGuide.activeBackground1': p['faint'],
		'editorWhitespace.foreground': p['ghost'],
		'editorRuler.foreground': p['border'],
		'editorCodeLens.foreground': p['faint'],
		'editorBracketMatch.background': p['accent'] + '1a',
		'editorBracketMatch.border': p['accent'] + '80',
		'editorBracketHighlight.foreground1': p['muted'],
		'editorBracketHighlight.foreground2': p['muted'],
		'editorBracketHighlight.foreground3': p['muted'],
		'editorBracketHighlight.foreground4': p['muted'],
		'editorBracketHighlight.foreground5': p['muted'],
		'editorBracketHighlight.foreground6': p['muted'],
		'editorBracketHighlight.unexpectedBracket.foreground': p['red'],
		'editorGutter.background': p['bg'],
		'editorGutter.addedBackground': p['added'],
		'editorGutter.modifiedBackground': p['muted'],
		'editorGutter.deletedBackground': p['removed'],
		'editorError.foreground': p['red'],
		'editorWarning.foreground': p['yellow'],
		'editorInfo.foreground': p['muted'],
		'editorHint.foreground': p['faint'],
		'editorUnnecessaryCode.opacity': '#000000a0',
		'editorInlayHint.background': T,
		'editorInlayHint.foreground': p['faint'],
		'editorGhostText.foreground': p['faint'],
		'editorOverviewRuler.border': p['bg'],
		'editorOverviewRuler.addedForeground': p['added'] + '99',
		'editorOverviewRuler.modifiedForeground': p['muted'] + '99',
		'editorOverviewRuler.deletedForeground': p['removed'] + '99',
		'editorOverviewRuler.errorForeground': p['red'],
		'editorOverviewRuler.warningForeground': p['yellow'],
		'editorOverviewRuler.findMatchForeground': p['accent'] + '99',
		'editorStickyScroll.background': p['bg'],
		'editorStickyScroll.border': p['border'],
		'editorStickyScroll.shadow': p['shadow'],
		'editorStickyScrollHover.background': p['surface'],
		'editorWidget.background': p['surface'],
		'editorWidget.foreground': p['fg'],
		'editorWidget.border': p['borderStrong'],
		'editorHoverWidget.background': p['surface'],
		'editorHoverWidget.border': p['borderStrong'],
		'editorSuggestWidget.background': p['surface'],
		'editorSuggestWidget.border': p['borderStrong'],
		'editorSuggestWidget.foreground': p['fg'],
		'editorSuggestWidget.selectedBackground': p['select'],
		'editorSuggestWidget.highlightForeground': p['accentText'],
		'editorSuggestWidget.focusHighlightForeground': p['accentText'],
		'editorSuggestWidget.focusOutline': T,
		'editorCommentsWidget.rangeBackground': p['wordHighlight'],
		'editorCommentsWidget.rangeActiveBackground': p['selection'],
		'minimap.background': p['bg'],
		'minimapSlider.background': p['scrollbar'],
		'minimapSlider.hoverBackground': p['scrollbarHover'],
		'minimapSlider.activeBackground': p['scrollbarActive'],
		'scrollbarSlider.background': p['scrollbar'],
		'scrollbarSlider.hoverBackground': p['scrollbarHover'],
		'scrollbarSlider.activeBackground': p['scrollbarActive'],

		# diff
		'diffEditor.insertedLineBackground': p['addedBg'],
		'diffEditor.insertedTextBackground': p['addedText'],
		'diffEditor.removedLineBackground': p['removedBg'],
		'diffEditor.removedTextBackground': p['removedText'],
		'diffEditor.border': p['border'],
		'diffEditor.diagonalFill': p['ghost'],

		# peek
		'peekView.border': p['accent'] + '80',
		'peekViewEditor.background': p['surface'],
		'peekViewEditor.matchHighlightBackground': p['findMatch'],
		'peekViewResult.background': p['bg'],
		'peekViewResult.fileForeground': p['bright'],
		'peekViewResult.lineForeground': p['muted'],
		'peekViewResult.matchHighlightBackground': p['findMatch'],
		'peekViewResult.selectionBackground': p['select'],
		'peekViewResult.selectionForeground': p['bright'],
		'peekViewTitle.background': p['surface'],
		'peekViewTitleLabel.foreground': p['bright'],
		'peekViewTitleDescription.foreground': p['muted'],

		# panel & terminal
		'panel.background': p['bg'],
		'panel.border': p['border'],
		'panelInput.border': p['borderStrong'],
		'panelTitle.activeForeground': p['bright'],
		'panelTitle.inactiveForeground': p['faint'],
		'panelTitle.activeBorder': p['accent'],
		'panelSection.border': p['border'],
		'panelSectionHeader.background': p['bg'],
		'panelSectionHeader.border': p['border'],
		'terminal.background': p['bg'],
		'terminal.foreground': p['fg'],
		'terminal.border': p['border'],
		'terminal.selectionBackground': p['selection'],
		'terminal.tab.activeBorder': p['accent'],
		'terminalCursor.foreground': p['accent'],
		'terminalCursor.background': p['bg'],

		# status bar
		'statusBar.background': p['bg'],
		'statusBar.foreground': p['muted'],
		'statusBar.border': p['border'],
		'statusBar.focusBorder': p['accent'],
		'statusBar.noFolderBackground': p['bg'],
		'statusBar.noFolderForeground': p['muted'],
		'statusBar.debuggingBackground': p['button'],
		'statusBar.debuggingForeground': p['buttonFg'],
		'statusBar.debuggingBorder': p['border'],
		'statusBarItem.hoverBackground': p['raised'],
		'statusBarItem.hoverForeground': p['bright'],
		'statusBarItem.activeBackground': p['select'],
		'statusBarItem.focusBorder': p['accent'],
		'statusBarItem.remoteBackground': p['bg'],
		'statusBarItem.remoteForeground': p['accentText'],
		'statusBarItem.remoteHoverBackground': p['raised'],
		'statusBarItem.prominentBackground': p['raised'],
		'statusBarItem.prominentForeground': p['bright'],
		'statusBarItem.prominentHoverBackground': p['select'],
		'statusBarItem.errorBackground': p['bg'],
		'statusBarItem.errorForeground': p['red'],
		'statusBarItem.warningBackground': p['bg'],
		'statusBarItem.warningForeground': p['yellow'],

		# menus, quick input, notifications
		'menu.background': p['surface'],
		'menu.foreground': p['fg'],
		'menu.border': p['borderStrong'],
		'menu.selectionBackground': p['select'],
		'menu.selectionForeground': p['bright'],
		'menu.selectionBorder': T,
		'menu.separatorBackground': p['borderStrong'],
		'menubar.selectionBackground': p['raised'],
		'menubar.selectionForeground': p['bright'],
		'quickInput.background': p['surface'],
		'quickInput.foreground': p['fg'],
		'quickInputTitle.background': p['surface'],
		'quickInputList.focusBackground': p['select'],
		'quickInputList.focusForeground': p['bright'],
		'quickInputList.focusIconForeground': p['bright'],
		'quickInputList.focusHighlightForeground': p['accentText'],
		'pickerGroup.border': p['borderStrong'],
		'pickerGroup.foreground': p['accentText'],
		'notifications.background': p['surface'],
		'notifications.foreground': p['fg'],
		'notifications.border': p['borderStrong'],
		'notificationToast.border': p['borderStrong'],
		'notificationCenter.border': p['borderStrong'],
		'notificationCenterHeader.background': p['surface'],
		'notificationCenterHeader.foreground': p['muted'],
		'notificationLink.foreground': p['accentText'],
		'notificationsErrorIcon.foreground': p['red'],
		'notificationsWarningIcon.foreground': p['yellow'],
		'notificationsInfoIcon.foreground': p['muted'],
		'debugToolBar.background': p['surface'],
		'debugToolBar.border': p['borderStrong'],

		# settings & welcome
		'settings.headerForeground': p['bright'],
		'settings.modifiedItemIndicator': p['accent'],
		'settings.dropdownBackground': p['surface'],
		'settings.dropdownBorder': p['borderStrong'],
		'settings.textInputBackground': p['surface'],
		'settings.textInputBorder': p['borderStrong'],
		'settings.numberInputBackground': p['surface'],
		'settings.numberInputBorder': p['borderStrong'],
		'settings.checkboxBackground': p['surface'],
		'settings.checkboxBorder': p['borderStrong'],
		'settings.focusedRowBackground': p['lineHighlight'],
		'settings.rowHoverBackground': p['lineHighlight'],
		'welcomePage.background': p['bg'],
		'welcomePage.tileBackground': p['surface'],
		'welcomePage.tileHoverBackground': p['raised'],
		'welcomePage.tileBorder': p['border'],
		'welcomePage.progress.foreground': p['accent'],
		'walkThrough.embeddedEditorBackground': p['surface'],

		# git decorations — additions and deletions keep their diff colors; the rest stays grey
		'gitDecoration.addedResourceForeground': p['added'],
		'gitDecoration.untrackedResourceForeground': p['added'],
		'gitDecoration.modifiedResourceForeground': p['bright'],
		'gitDecoration.stageModifiedResourceForeground': p['bright'],
		'gitDecoration.deletedResourceForeground': p['red'],
		'gitDecoration.stageDeletedResourceForeground': p['red'],
		'gitDecoration.conflictingResourceForeground': p['yellow'],
		'gitDecoration.ignoredResourceForeground': p['faint'],
		'gitDecoration.renamedResourceForeground': p['fg'],
		'gitDecoration.submoduleResourceForeground': p['muted'],

		# charts (HivemindIDE's own panels read charts.green)
		'charts.foreground': p['fg'],
		'charts.lines': p['borderStrong'],
		'charts.green': p['accent'],
		'charts.red': p['red'],
		'charts.yellow': p['yellow'],
		'charts.orange': p['orange'],
		'charts.blue': p['blue'],
		'charts.purple': p['purple'],

		# chat
		'chat.requestBubbleBackground': p['surface'],
		'chat.requestBubbleHoverBackground': p['raised'],
		'chat.slashCommandBackground': p['accent'] + '22',
		'chat.slashCommandForeground': p['accentText'],
		'chat.editedFileForeground': p['yellow'],
		'chat.avatarBackground': p['raised'],
		'chat.avatarForeground': p['fg'],
		'inlineChat.background': p['surface'],
		'inlineChat.border': p['borderStrong'],
		'interactive.activeCodeBorder': p['accent'] + '80',
		'interactive.inactiveCodeBorder': p['border'],

		# visor gradient stops — drawn by contrib/hivemindide/browser/media/visor.css
		'hivemind.visorStart': p['visor'][0],
		'hivemind.visorMid': p['visor'][1],
		'hivemind.visorEnd': p['visor'][2],

		# misc
		'actionBar.toggledBackground': p['select'],
		'tab.selectedBackground': p['bg'],
		'tab.selectedForeground': p['bright'],
		'terminal.inactiveSelectionBackground': p['selectionInactive'],
		'ports.iconRunningProcessForeground': p['accentText'],
		'diffEditor.unchangedRegionBackground': p['surface'],
		'list.focusAndSelectionOutline': p['accent'] + '66',
		'notebook.cellBorderColor': p['border'],
		'notebook.selectedCellBackground': p['surface'],
		'searchEditor.textInputBorder': p['borderStrong'],
		'statusBarItem.compactHoverBackground': p['raised'],
	}
	for k, v in p['ansi'].items():
		c['terminal.ansi' + k[0].upper() + k[1:]] = v
	# Chat working beam: one lens per rotation. Only the multi-lens themes set
	# it; the single-lens themes keep a one-color beam.
	for i, v in enumerate(p.get('beam', ()), 1):
		c[f'hivemind.beam{i}'] = v
	# No ring behind the beam: only the beam itself marks the working input.
	c['hivemind.beamTrack'] = '#00000000'
	return c


def roles(p):
	"""Syntax roles with fallbacks. A single-lens theme sets only the base roles;
	Dynamic also sets module (imports) / control / parameter / self / decorator."""
	s = dict(p['syntax'])
	s.setdefault('module', s['keyword'])
	s.setdefault('control', s['keyword'])
	s.setdefault('parameter', s['variable'])
	s.setdefault('self', s['keyword'])
	s.setdefault('decorator', s['property'])
	return s


def token_colors(p):
	s = roles(p)

	def rule(name, scope, fg, style=None):
		settings = {'foreground': fg}
		if style is not None:
			settings['fontStyle'] = style
		return {'name': name, 'scope': scope, 'settings': settings}

	return [
		rule('Comment', ['comment', 'punctuation.definition.comment', 'string.comment'], s['comment'], 'italic'),
		rule('Keyword', ['keyword', 'storage', 'storage.type', 'storage.modifier', 'keyword.other.using', 'keyword.other.operator'], s['keyword'], ''),
		rule('Control flow', ['keyword.control', 'keyword.control.flow', 'keyword.control.conditional', 'keyword.control.loop', 'keyword.control.trycatch'], s['control'], ''),
		rule('Import', ['keyword.control.import', 'keyword.control.export', 'keyword.control.from', 'keyword.control.default', 'keyword.control.as', 'keyword.other.import', 'keyword.import', 'keyword.package', 'keyword.other.package', 'keyword.control.module', 'keyword.other.use', 'keyword.other.crate'], s['module'], ''),
		rule('Operator', ['keyword.operator', 'punctuation.accessor', 'punctuation.separator.key-value'], s['operator']),
		rule('Keyword operators', ['keyword.operator.new', 'keyword.operator.expression', 'keyword.operator.logical.python', 'keyword.operator.wordlike', 'keyword.operator.instanceof', 'keyword.operator.typeof'], s['control']),
		rule('String', ['string', 'string.quoted', 'string.template', 'string.unquoted', 'markup.inline.raw', 'markup.fenced_code'], s['string']),
		rule('Template expression', ['punctuation.definition.template-expression', 'punctuation.section.embedded'], s['operator']),
		rule('Escape', ['constant.character.escape', 'constant.character.format.placeholder', 'constant.other.placeholder'], s['escape']),
		rule('Regex', ['string.regexp', 'constant.regexp'], s['regex']),
		rule('Constant', ['constant', 'constant.numeric', 'constant.language', 'constant.character', 'support.constant', 'variable.other.constant', 'variable.other.enummember', 'keyword.other.unit'], s['constant']),
		rule('Function', ['entity.name.function', 'support.function', 'meta.function-call.generic', 'entity.name.method', 'variable.function'], s['function']),
		rule('Type', ['entity.name.type', 'entity.name.class', 'entity.name.namespace', 'entity.other.inherited-class', 'support.type', 'support.class', 'entity.name.type.module', 'meta.type.annotation', 'storage.type.primitive', 'storage.type.built-in'], s['type']),
		rule('Variable', ['variable', 'variable.other', 'meta.definition.variable.name', 'support.variable'], s['variable']),
		rule('Parameter', ['variable.parameter', 'meta.parameter'], s['parameter']),
		rule('Language variable', ['variable.language', 'variable.language.this', 'variable.language.self', 'variable.language.super'], s['self']),
		rule('Property', ['variable.other.property', 'variable.other.object.property', 'meta.object-literal.key', 'support.type.property-name', 'entity.name.tag.yaml', 'support.type.property-name.json'], s['property']),
		rule('Punctuation', ['punctuation', 'meta.brace', 'punctuation.definition.tag', 'punctuation.separator', 'punctuation.terminator'], s['punctuation']),
		rule('Tag', ['entity.name.tag', 'support.class.component'], s['tag']),
		rule('Attribute', ['entity.other.attribute-name', 'entity.other.attribute-name.class.css', 'entity.other.attribute-name.id.css'], s['attribute']),
		rule('CSS property value', ['support.constant.property-value', 'support.constant.color', 'constant.other.color'], s['constant']),
		rule('Decorator', ['meta.decorator', 'punctuation.decorator', 'entity.name.function.decorator', 'meta.attribute'], s['decorator']),
		rule('Preprocessor', ['meta.preprocessor', 'keyword.control.directive', 'entity.name.function.preprocessor'], s['keyword']),
		rule('Heading', ['markup.heading', 'markup.heading entity.name', 'entity.name.section'], s['keyword'], 'bold'),
		rule('Bold', ['markup.bold'], s['keyword'], 'bold'),
		rule('Italic', ['markup.italic'], s['function'], 'italic'),
		rule('Strikethrough', ['markup.strikethrough'], s['comment'], 'strikethrough'),
		rule('Link', ['markup.underline.link', 'string.other.link', 'meta.link'], s['constant'], 'underline'),
		rule('Quote', ['markup.quote'], s['property'], 'italic'),
		rule('List', ['punctuation.definition.list.begin.markdown', 'beginning.punctuation.definition.list'], s['constant']),
		rule('Inserted', ['markup.inserted', 'meta.diff.header.to-file', 'punctuation.definition.inserted'], p['added']),
		rule('Deleted', ['markup.deleted', 'meta.diff.header.from-file', 'punctuation.definition.deleted'], p['removed']),
		rule('Changed', ['markup.changed', 'punctuation.definition.changed'], p['yellow']),
		rule('Diff range', ['meta.diff.range', 'meta.diff.header'], s['property']),
		rule('Invalid', ['invalid', 'invalid.illegal'], s['invalid']),
		rule('Deprecated', ['invalid.deprecated'], s['comment'], 'strikethrough'),
	]


def semantic(p):
	s = roles(p)
	return {
		'variable.readonly': s['variable'],
		'variable.defaultLibrary': s['type'],
		'property.readonly': s['property'],
		'enumMember': s['constant'],
		'parameter': s['parameter'],
		'namespace': s['type'],
		'type': s['type'],
		'class': s['type'],
		'interface': s['type'],
		'typeParameter': s['type'],
		'function': s['function'],
		'method': s['function'],
		'function.defaultLibrary': s['function'],
		'decorator': s['decorator'],
		'selfKeyword': s['self'],
		'*.deprecated': {'strikethrough': True},
	}


for pal, fname in (
	(DYNAMIC, 'hivemind-dynamic.json'),
	(EMBER, 'hivemind-ember.json'), (JADE, 'hivemind-jade.json'), (COBALT, 'hivemind-cobalt.json'),
	(VIOLET, 'hivemind-violet.json'), (CHROME, 'hivemind-chrome.json'), (LIGHT, 'hivemind-light.json'),
):
	theme = {
		'$schema': 'vscode://schemas/color-theme',
		'name': pal['name'],
		'type': pal['type'],
		'semanticHighlighting': True,
		'colors': colors(pal),
		'tokenColors': token_colors(pal),
		'semanticTokenColors': semantic(pal),
	}
	with open(f'{OUT}/{fname}', 'w') as f:
		json.dump(theme, f, indent='\t')
		f.write('\n')
	print(fname, len(theme['colors']), 'colors')
