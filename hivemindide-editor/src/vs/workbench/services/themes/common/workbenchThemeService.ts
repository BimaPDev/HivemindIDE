/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { refineServiceDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { Event } from '../../../../base/common/event.js';
import { Color } from '../../../../base/common/color.js';
import { IColorTheme, IThemeService, IFileIconTheme, IProductIconTheme } from '../../../../platform/theme/common/themeService.js';
import { ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { isBoolean, isString } from '../../../../base/common/types.js';
import { IconContribution, IconDefinition } from '../../../../platform/theme/common/iconRegistry.js';
import { ColorScheme, ThemeTypeSelector } from '../../../../platform/theme/common/theme.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';

export const IWorkbenchThemeService = refineServiceDecorator<IThemeService, IWorkbenchThemeService>(IThemeService);

export const THEME_SCOPE_OPEN_PAREN = '[';
export const THEME_SCOPE_CLOSE_PAREN = ']';
export const THEME_SCOPE_WILDCARD = '*';

export const themeScopeRegex = /\[(.+?)\]/g;

export enum ThemeSettings {
	COLOR_THEME = 'workbench.colorTheme',
	FILE_ICON_THEME = 'workbench.iconTheme',
	PRODUCT_ICON_THEME = 'workbench.productIconTheme',
	COLOR_CUSTOMIZATIONS = 'workbench.colorCustomizations',
	TOKEN_COLOR_CUSTOMIZATIONS = 'editor.tokenColorCustomizations',
	SEMANTIC_TOKEN_COLOR_CUSTOMIZATIONS = 'editor.semanticTokenColorCustomizations',

	PREFERRED_DARK_THEME = 'workbench.preferredDarkColorTheme',
	PREFERRED_LIGHT_THEME = 'workbench.preferredLightColorTheme',
	PREFERRED_HC_DARK_THEME = 'workbench.preferredHighContrastColorTheme', /* id kept for compatibility reasons */
	PREFERRED_HC_LIGHT_THEME = 'workbench.preferredHighContrastLightColorTheme',
	DETECT_COLOR_SCHEME = 'window.autoDetectColorScheme',
	DETECT_HC = 'window.autoDetectHighContrast',

	SYSTEM_COLOR_THEME = 'window.systemColorTheme'
}

export namespace ThemeSettingDefaults {
	export const COLOR_THEME_DARK = 'Hivemind Dynamic';
	export const COLOR_THEME_LIGHT = 'Hivemind Light';
	export const COLOR_THEME_HC_DARK = 'Default High Contrast';
	export const COLOR_THEME_HC_LIGHT = 'Default High Contrast Light';

	export const FILE_ICON_THEME = 'vscode-modern-icons';
	export const PRODUCT_ICON_THEME = 'Default';
}

/**
 * Migrates legacy theme settings IDs to their current equivalents.
 * Theme IDs were simplified: "Default" prefix was removed from built-in themes,
 * and "Experimental" prefix was replaced when VS Code themes became GA.
 */
export function migrateThemeSettingsId(settingsId: string): string {
	switch (settingsId) {
		case 'Default Dark Modern': return 'Dark Modern';
		case 'Default Light Modern': return 'Light Modern';
		case 'Default Dark+': return 'Dark+';
		case 'Default Light+': return 'Light+';
		case 'Experimental Dark':
		case 'VS Code Dark':
			return ThemeSettingDefaults.COLOR_THEME_DARK;
		case 'Experimental Light':
		case 'VS Code Light':
			return ThemeSettingDefaults.COLOR_THEME_LIGHT;
	}
	return settingsId;
}

export const COLOR_THEME_DARK_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#1d1d1d',
	'activityBar.activeBorder': '#ff7a1a',
	'activityBar.background': '#0b0b0b',
	'activityBar.border': '#1a1a1a',
	'activityBar.foreground': '#f4f4f4',
	'activityBar.inactiveForeground': '#474747',
	'activityBarBadge.background': '#ff7a1a',
	'activityBarBadge.foreground': '#0b0b0b',
	'badge.background': '#ff7a1a',
	'badge.foreground': '#0b0b0b',
	'button.background': '#ff7a1a',
	'button.border': 'transparent',
	'button.foreground': '#0b0b0b',
	'button.hoverBackground': '#ff9447',
	'button.secondaryBackground': '#171717',
	'button.secondaryForeground': '#c9c9c9',
	'button.secondaryHoverBackground': '#1d1d1d',
	'chat.slashCommandBackground': '#ff7a1a22',
	'chat.slashCommandForeground': '#ff8f3f',
	'chat.editedFileForeground': '#ffc53d',
	'checkbox.background': '#111111',
	'checkbox.border': '#262626',
	'debugToolBar.background': '#111111',
	'descriptionForeground': '#7a7a7a',
	'dropdown.background': '#111111',
	'dropdown.border': '#262626',
	'dropdown.foreground': '#c9c9c9',
	'dropdown.listBackground': '#111111',
	'editor.background': '#0b0b0b',
	'editor.findMatchBackground': '#ff7a1a55',
	'editor.foreground': '#c9c9c9',
	'editor.inactiveSelectionBackground': '#ffffff12',
	'editor.selectionHighlightBackground': '#ffffff14',
	'editorGroup.border': '#1a1a1a',
	'editorGroupHeader.tabsBackground': '#0b0b0b',
	'editorGroupHeader.tabsBorder': '#1a1a1a',
	'editorGutter.addedBackground': '#8fd694',
	'editorGutter.deletedBackground': '#ff4f6d',
	'editorGutter.modifiedBackground': '#7a7a7a',
	'editorIndentGuide.activeBackground1': '#474747',
	'editorIndentGuide.background1': '#262626',
	'editorLineNumber.activeForeground': '#f4f4f4',
	'editorLineNumber.foreground': '#363636',
	'editorOverviewRuler.border': '#0b0b0b',
	'editorWidget.background': '#111111',
	'errorForeground': '#ff4f6d',
	'focusBorder': '#ff7a1a80',
	'foreground': '#c9c9c9',
	'icon.foreground': '#7a7a7a',
	'input.background': '#111111',
	'input.border': '#262626',
	'input.foreground': '#c9c9c9',
	'input.placeholderForeground': '#474747',
	'inputOption.activeBackground': '#ff7a1a22',
	'inputOption.activeBorder': '#ff7a1a80',
	'keybindingLabel.foreground': '#c9c9c9',
	'list.activeSelectionIconForeground': '#f4f4f4',
	'list.dropBackground': '#ff7a1a1a',
	'menu.background': '#111111',
	'menu.border': '#262626',
	'menu.foreground': '#c9c9c9',
	'menu.selectionBackground': '#1d1d1d',
	'menu.separatorBackground': '#262626',
	'notificationCenterHeader.background': '#111111',
	'notificationCenterHeader.foreground': '#7a7a7a',
	'notifications.background': '#111111',
	'notifications.border': '#262626',
	'notifications.foreground': '#c9c9c9',
	'panel.background': '#0b0b0b',
	'panel.border': '#1a1a1a',
	'panelInput.border': '#262626',
	'panelTitle.activeBorder': '#ff7a1a',
	'panelTitle.activeForeground': '#f4f4f4',
	'panelTitle.inactiveForeground': '#474747',
	'peekViewEditor.background': '#111111',
	'peekViewEditor.matchHighlightBackground': '#ff7a1a55',
	'peekViewResult.background': '#0b0b0b',
	'peekViewResult.matchHighlightBackground': '#ff7a1a55',
	'pickerGroup.border': '#262626',
	'ports.iconRunningProcessForeground': '#ff8f3f',
	'progressBar.background': '#ff7a1a',
	'quickInput.background': '#111111',
	'quickInput.foreground': '#c9c9c9',
	'settings.dropdownBackground': '#111111',
	'settings.dropdownBorder': '#262626',
	'settings.headerForeground': '#f4f4f4',
	'settings.modifiedItemIndicator': '#ff7a1a',
	'sideBar.background': '#0b0b0b',
	'sideBar.border': '#1a1a1a',
	'sideBar.foreground': '#c9c9c9',
	'sideBarSectionHeader.background': '#0b0b0b',
	'sideBarSectionHeader.border': '#1a1a1a',
	'sideBarSectionHeader.foreground': '#7a7a7a',
	'sideBarTitle.foreground': '#7a7a7a',
	'statusBar.background': '#0b0b0b',
	'statusBar.border': '#1a1a1a',
	'statusBar.debuggingBackground': '#ff7a1a',
	'statusBar.debuggingForeground': '#0b0b0b',
	'statusBar.focusBorder': '#ff7a1a',
	'statusBar.foreground': '#7a7a7a',
	'statusBar.noFolderBackground': '#0b0b0b',
	'statusBarItem.focusBorder': '#ff7a1a',
	'statusBarItem.prominentBackground': '#171717',
	'statusBarItem.remoteBackground': '#0b0b0b',
	'statusBarItem.remoteForeground': '#ff8f3f',
	'tab.activeBackground': '#0b0b0b',
	'tab.activeBorder': '#0b0b0b',
	'tab.activeBorderTop': '#ff7a1a',
	'tab.activeForeground': '#f4f4f4',
	'tab.border': '#1a1a1a',
	'tab.hoverBackground': '#111111',
	'tab.inactiveBackground': '#0b0b0b',
	'tab.inactiveForeground': '#474747',
	'tab.lastPinnedBorder': '#262626',
	'tab.selectedBackground': '#0b0b0b',
	'tab.selectedBorderTop': '#ff7a1a',
	'tab.selectedForeground': '#f4f4f4',
	'tab.unfocusedActiveBorder': '#0b0b0b',
	'tab.unfocusedActiveBorderTop': '#474747',
	'tab.unfocusedHoverBackground': '#111111',
	'terminal.foreground': '#c9c9c9',
	'terminal.inactiveSelectionBackground': '#ffffff12',
	'terminal.tab.activeBorder': '#ff7a1a',
	'textBlockQuote.background': '#111111',
	'textBlockQuote.border': '#262626',
	'textCodeBlock.background': '#111111',
	'textLink.activeForeground': '#ff8f3f',
	'textLink.foreground': '#ff8f3f',
	'textPreformat.background': '#171717',
	'textPreformat.foreground': '#f4f4f4',
	'textSeparator.foreground': '#1a1a1a',
	'titleBar.activeBackground': '#0b0b0b',
	'titleBar.activeForeground': '#7a7a7a',
	'titleBar.border': '#1a1a1a',
	'titleBar.inactiveBackground': '#0b0b0b',
	'titleBar.inactiveForeground': '#474747',
	'welcomePage.progress.foreground': '#ff7a1a',
	'welcomePage.tileBackground': '#111111',
	'widget.border': '#262626',
};

export const COLOR_THEME_LIGHT_INITIAL_COLORS = {
	'actionBar.toggledBackground': '#e3e3e0',
	'activityBar.activeBorder': '#d9540a',
	'activityBar.background': '#f5f5f3',
	'activityBar.border': '#e4e4e1',
	'activityBar.foreground': '#0b0b0b',
	'activityBar.inactiveForeground': '#a6a6a6',
	'activityBarBadge.background': '#f26b0f',
	'activityBarBadge.foreground': '#0b0b0b',
	'badge.background': '#f26b0f',
	'badge.foreground': '#0b0b0b',
	'button.background': '#f26b0f',
	'button.border': 'transparent',
	'button.foreground': '#0b0b0b',
	'button.hoverBackground': '#f5802f',
	'button.secondaryBackground': '#ececea',
	'button.secondaryForeground': '#262626',
	'button.secondaryHoverBackground': '#e3e3e0',
	'chat.slashCommandBackground': '#d9540a22',
	'chat.slashCommandForeground': '#b8430a',
	'chat.editedFileForeground': '#a67c00',
	'checkbox.background': '#ffffff',
	'checkbox.border': '#d0d0cc',
	'descriptionForeground': '#6b6b6b',
	'diffEditor.unchangedRegionBackground': '#ffffff',
	'dropdown.background': '#ffffff',
	'dropdown.border': '#d0d0cc',
	'dropdown.foreground': '#262626',
	'dropdown.listBackground': '#ffffff',
	'editor.background': '#f5f5f3',
	'editor.foreground': '#262626',
	'editor.inactiveSelectionBackground': '#0000000f',
	'editor.selectionHighlightBackground': '#00000012',
	'editorGroup.border': '#e4e4e1',
	'editorGroupHeader.tabsBackground': '#f5f5f3',
	'editorGroupHeader.tabsBorder': '#e4e4e1',
	'editorGutter.addedBackground': '#3f8a3a',
	'editorGutter.deletedBackground': '#d42e4f',
	'editorGutter.modifiedBackground': '#6b6b6b',
	'editorIndentGuide.activeBackground1': '#a6a6a6',
	'editorIndentGuide.background1': '#dcdcd8',
	'editorLineNumber.activeForeground': '#0b0b0b',
	'editorLineNumber.foreground': '#a6a6a6',
	'editorOverviewRuler.border': '#f5f5f3',
	'editorSuggestWidget.background': '#ffffff',
	'editorWidget.background': '#ffffff',
	'errorForeground': '#d42e4f',
	'focusBorder': '#d9540a80',
	'foreground': '#262626',
	'icon.foreground': '#6b6b6b',
	'input.background': '#ffffff',
	'input.border': '#d0d0cc',
	'input.foreground': '#262626',
	'input.placeholderForeground': '#a6a6a6',
	'inputOption.activeBackground': '#d9540a22',
	'inputOption.activeBorder': '#d9540a80',
	'inputOption.activeForeground': '#0b0b0b',
	'keybindingLabel.foreground': '#262626',
	'list.activeSelectionBackground': '#e3e3e0',
	'list.activeSelectionForeground': '#0b0b0b',
	'list.activeSelectionIconForeground': '#0b0b0b',
	'list.focusAndSelectionOutline': '#d9540a66',
	'list.hoverBackground': '#ececea',
	'menu.border': '#d0d0cc',
	'menu.selectionBackground': '#e3e3e0',
	'menu.selectionForeground': '#0b0b0b',
	'notebook.cellBorderColor': '#e4e4e1',
	'notebook.selectedCellBackground': '#ffffff',
	'notificationCenterHeader.background': '#ffffff',
	'notificationCenterHeader.foreground': '#6b6b6b',
	'notifications.background': '#ffffff',
	'notifications.border': '#d0d0cc',
	'notifications.foreground': '#262626',
	'panel.background': '#f5f5f3',
	'panel.border': '#e4e4e1',
	'panelInput.border': '#d0d0cc',
	'panelTitle.activeBorder': '#d9540a',
	'panelTitle.activeForeground': '#0b0b0b',
	'panelTitle.inactiveForeground': '#a6a6a6',
	'peekViewEditor.matchHighlightBackground': '#f26b0f4d',
	'peekViewResult.background': '#f5f5f3',
	'peekViewResult.matchHighlightBackground': '#f26b0f4d',
	'pickerGroup.border': '#d0d0cc',
	'pickerGroup.foreground': '#b8430a',
	'ports.iconRunningProcessForeground': '#b8430a',
	'progressBar.background': '#d9540a',
	'quickInput.background': '#ffffff',
	'quickInput.foreground': '#262626',
	'searchEditor.textInputBorder': '#d0d0cc',
	'settings.dropdownBackground': '#ffffff',
	'settings.dropdownBorder': '#d0d0cc',
	'settings.headerForeground': '#0b0b0b',
	'settings.modifiedItemIndicator': '#d9540a',
	'settings.numberInputBorder': '#d0d0cc',
	'settings.textInputBorder': '#d0d0cc',
	'sideBar.background': '#f5f5f3',
	'sideBar.border': '#e4e4e1',
	'sideBar.foreground': '#262626',
	'sideBarSectionHeader.background': '#f5f5f3',
	'sideBarSectionHeader.border': '#e4e4e1',
	'sideBarSectionHeader.foreground': '#6b6b6b',
	'sideBarTitle.foreground': '#6b6b6b',
	'statusBar.background': '#f5f5f3',
	'statusBar.border': '#e4e4e1',
	'statusBar.debuggingBackground': '#f26b0f',
	'statusBar.debuggingForeground': '#0b0b0b',
	'statusBar.focusBorder': '#d9540a',
	'statusBar.foreground': '#6b6b6b',
	'statusBar.noFolderBackground': '#f5f5f3',
	'statusBarItem.compactHoverBackground': '#ececea',
	'statusBarItem.errorBackground': '#f5f5f3',
	'statusBarItem.focusBorder': '#d9540a',
	'statusBarItem.hoverBackground': '#ececea',
	'statusBarItem.prominentBackground': '#ececea',
	'statusBarItem.remoteBackground': '#f5f5f3',
	'statusBarItem.remoteForeground': '#b8430a',
	'tab.activeBackground': '#f5f5f3',
	'tab.activeBorder': '#f5f5f3',
	'tab.activeBorderTop': '#d9540a',
	'tab.activeForeground': '#0b0b0b',
	'tab.border': '#e4e4e1',
	'tab.hoverBackground': '#ffffff',
	'tab.inactiveBackground': '#f5f5f3',
	'tab.inactiveForeground': '#a6a6a6',
	'tab.lastPinnedBorder': '#d0d0cc',
	'tab.selectedBackground': '#f5f5f3',
	'tab.selectedBorderTop': '#d9540a',
	'tab.selectedForeground': '#0b0b0b',
	'tab.unfocusedActiveBorder': '#f5f5f3',
	'tab.unfocusedActiveBorderTop': '#a6a6a6',
	'tab.unfocusedHoverBackground': '#ffffff',
	'terminal.foreground': '#262626',
	'terminal.inactiveSelectionBackground': '#0000000f',
	'terminal.tab.activeBorder': '#d9540a',
	'terminalCursor.foreground': '#d9540a',
	'textBlockQuote.background': '#ffffff',
	'textBlockQuote.border': '#d0d0cc',
	'textCodeBlock.background': '#ffffff',
	'textLink.activeForeground': '#b8430a',
	'textLink.foreground': '#b8430a',
	'textPreformat.background': '#ececea',
	'textPreformat.foreground': '#0b0b0b',
	'textSeparator.foreground': '#e4e4e1',
	'titleBar.activeBackground': '#f5f5f3',
	'titleBar.activeForeground': '#6b6b6b',
	'titleBar.border': '#e4e4e1',
	'titleBar.inactiveBackground': '#f5f5f3',
	'titleBar.inactiveForeground': '#a6a6a6',
	'welcomePage.tileBackground': '#ffffff',
	'widget.border': '#d0d0cc',
};

export interface IWorkbenchTheme {
	readonly id: string;
	readonly label: string;
	readonly extensionData?: ExtensionData;
	readonly description?: string;
	readonly settingsId: string | null;
}

export interface IWorkbenchColorTheme extends IWorkbenchTheme, IColorTheme {
	readonly settingsId: string;
	readonly tokenColors: ITextMateThemingRule[];
}

export interface IColorMap {
	[id: string]: Color;
}

export interface IWorkbenchFileIconTheme extends IWorkbenchTheme, IFileIconTheme {
}

export interface IWorkbenchProductIconTheme extends IWorkbenchTheme, IProductIconTheme {
	readonly settingsId: string;

	getIcon(icon: IconContribution): IconDefinition | undefined;
}

export type ThemeSettingTarget = ConfigurationTarget | undefined | 'auto' | 'preview';


export interface IWorkbenchThemeService extends IThemeService {
	readonly _serviceBrand: undefined;
	setColorTheme(themeId: string | undefined | IWorkbenchColorTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchColorTheme | null>;
	getColorTheme(): IWorkbenchColorTheme;
	/** Returns the selected theme and user customizations without window-local overlays. */
	getBaseColorTheme(): IWorkbenchColorTheme;
	getColorThemes(): Promise<IWorkbenchColorTheme[]>;
	getMarketplaceColorThemes(publisher: string, name: string, version: string): Promise<IWorkbenchColorTheme[]>;
	readonly onDidColorThemeChange: Event<IWorkbenchColorTheme>;

	/** Applies window-local colors computed from the base theme, without persisting them or changing the selected theme. */
	registerColorThemeOverlay(getColors: (theme: IWorkbenchColorTheme) => IColorMap): IDisposable;

	getPreferredColorScheme(): ColorScheme | undefined;

	setFileIconTheme(iconThemeId: string | undefined | IWorkbenchFileIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchFileIconTheme>;
	getFileIconTheme(): IWorkbenchFileIconTheme;
	getFileIconThemes(): Promise<IWorkbenchFileIconTheme[]>;
	getMarketplaceFileIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchFileIconTheme[]>;
	readonly onDidFileIconThemeChange: Event<IWorkbenchFileIconTheme>;

	setProductIconTheme(iconThemeId: string | undefined | IWorkbenchProductIconTheme, settingsTarget: ThemeSettingTarget): Promise<IWorkbenchProductIconTheme>;
	getProductIconTheme(): IWorkbenchProductIconTheme;
	getProductIconThemes(): Promise<IWorkbenchProductIconTheme[]>;
	getMarketplaceProductIconThemes(publisher: string, name: string, version: string): Promise<IWorkbenchProductIconTheme[]>;
	readonly onDidProductIconThemeChange: Event<IWorkbenchProductIconTheme>;
}

export interface IThemeScopedColorCustomizations {
	[colorId: string]: string;
}

export interface IColorCustomizations {
	[colorIdOrThemeScope: string]: IThemeScopedColorCustomizations | string;
}

export interface IThemeScopedTokenColorCustomizations {
	[groupId: string]: ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface ITokenColorCustomizations {
	[groupIdOrThemeScope: string]: IThemeScopedTokenColorCustomizations | ITextMateThemingRule[] | ITokenColorizationSetting | boolean | string | undefined;
	comments?: string | ITokenColorizationSetting;
	strings?: string | ITokenColorizationSetting;
	numbers?: string | ITokenColorizationSetting;
	keywords?: string | ITokenColorizationSetting;
	types?: string | ITokenColorizationSetting;
	functions?: string | ITokenColorizationSetting;
	variables?: string | ITokenColorizationSetting;
	textMateRules?: ITextMateThemingRule[];
	semanticHighlighting?: boolean; // deprecated, use ISemanticTokenColorCustomizations.enabled instead
}

export interface IThemeScopedSemanticTokenColorCustomizations {
	[styleRule: string]: ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface ISemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedSemanticTokenColorCustomizations | ISemanticTokenRules | boolean | undefined;
	enabled?: boolean;
	rules?: ISemanticTokenRules;
}

export interface IThemeScopedExperimentalSemanticTokenColorCustomizations {
	[themeScope: string]: ISemanticTokenRules | undefined;
}

export interface IExperimentalSemanticTokenColorCustomizations {
	[styleRuleOrThemeScope: string]: IThemeScopedExperimentalSemanticTokenColorCustomizations | ISemanticTokenRules | undefined;
}

export type IThemeScopedCustomizations =
	IThemeScopedColorCustomizations
	| IThemeScopedTokenColorCustomizations
	| IThemeScopedExperimentalSemanticTokenColorCustomizations
	| IThemeScopedSemanticTokenColorCustomizations;

export type IThemeScopableCustomizations =
	IColorCustomizations
	| ITokenColorCustomizations
	| IExperimentalSemanticTokenColorCustomizations
	| ISemanticTokenColorCustomizations;

export interface ISemanticTokenRules {
	[selector: string]: string | ISemanticTokenColorizationSetting | undefined;
}

export interface ITextMateThemingRule {
	name?: string;
	scope?: string | string[];
	settings: ITokenColorizationSetting;
}

export interface ITokenColorizationSetting {
	foreground?: string;
	background?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	fontFamily?: string;
	fontSize?: number;
	lineHeight?: number;
}

export interface ISemanticTokenColorizationSetting {
	foreground?: string;
	fontStyle?: string; /* [italic|bold|underline|strikethrough] */
	bold?: boolean;
	underline?: boolean;
	strikethrough?: boolean;
	italic?: boolean;
}

export interface ExtensionData {
	extensionId: string;
	extensionPublisher: string;
	extensionName: string;
	extensionIsBuiltin: boolean;
}

export namespace ExtensionData {
	export function toJSONObject(d: ExtensionData | undefined): any {
		return d && { _extensionId: d.extensionId, _extensionIsBuiltin: d.extensionIsBuiltin, _extensionName: d.extensionName, _extensionPublisher: d.extensionPublisher };
	}
	export function fromJSONObject(o: any): ExtensionData | undefined {
		if (o && isString(o._extensionId) && isBoolean(o._extensionIsBuiltin) && isString(o._extensionName) && isString(o._extensionPublisher)) {
			return { extensionId: o._extensionId, extensionIsBuiltin: o._extensionIsBuiltin, extensionName: o._extensionName, extensionPublisher: o._extensionPublisher };
		}
		return undefined;
	}
	export function fromName(publisher: string, name: string, isBuiltin = false): ExtensionData {
		return { extensionPublisher: publisher, extensionId: `${publisher}.${name}`, extensionName: name, extensionIsBuiltin: isBuiltin };
	}
}

export interface IThemeExtensionPoint {
	id: string;
	label?: string;
	description?: string;
	path: string;
	uiTheme?: ThemeTypeSelector;
	_watch: boolean; // unsupported options to watch location
}
