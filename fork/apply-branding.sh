#!/usr/bin/env bash
# Turns a microsoft/vscode checkout into HivemindIDE — branding + Microsoft strip.
#
# Mirrors what VSCodium does in prepare_vscode.sh / undo_telemetry.sh /
# 00-telemetry-disable.patch, but as idempotent scripts against a real fork
# rather than a patch set applied at build time.
#
# Everything here is re-runnable after an upstream merge. Keep it that way:
# hand-editing product.json in the checkout means the next merge conflict is
# yours to untangle by memory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
. "$SCRIPT_DIR/editor-dir.sh"
EDITOR_DIR="$(hivemindide_editor_dir)"

[ -d "$EDITOR_DIR" ] || { echo "no checkout at $EDITOR_DIR" >&2; exit 1; }
[ -f "$EDITOR_DIR/product.json" ] || { echo "$EDITOR_DIR is not a vscode checkout" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

if sed --version >/dev/null 2>&1; then
	SED_INPLACE=(sed -i -E)
else
	SED_INPLACE=(sed -i '' -E)
fi

log() { printf '\033[1m==> %s\033[0m\n' "$1"; }

# ---------------------------------------------------------------------------
# product.json — names, Open VSX, no Microsoft services
# ---------------------------------------------------------------------------
log "branding product.json"
# --tab matches product.json's existing indentation. Without it jq rewrites all
# 500 lines and every upstream merge conflicts on the whole file.
jq --tab '
  .nameShort              = "HivemindIDE"
| .nameLong               = "HivemindIDE"
| .applicationName        = "hivemindide"
| .serverApplicationName  = "hivemindide-server"
| .dataFolderName         = ".hivemindide"
| .serverDataFolderName   = ".hivemindide-server"
| .urlProtocol            = "hivemindide"
| .darwinBundleIdentifier = "com.hivemindide.HivemindIDE"
| .win32DirName           = "HivemindIDE"
| .win32NameVersion       = "HivemindIDE"
| .win32RegValueName      = "HivemindIDE"
| .win32AppUserModelId    = "HivemindIDE.HivemindIDE"
| .win32ShellNameShort    = "HivemindIDE"
| .linuxIconName          = "hivemindide"
| .sharedDataFolderName    = ".hivemindide-shared"
| .win32MutexName          = "hivemindide"
| .win32TunnelServiceMutex = "hivemindide-tunnelservice"
| .win32TunnelMutex        = "hivemindide-tunnel"
| .tunnelApplicationName   = "hivemindide-tunnel"
| .linuxDesktopName        = "com.hivemindide.HivemindIDE"

# Open VSX. Forking vscode directly means we do not inherit this from
# VSCodium — the Microsoft marketplace is licensed to Microsoft products only,
# so pointing at it would not just be rude, it would be a licence breach.
| .extensionsGallery = {
    "serviceUrl": "https://open-vsx.org/vscode/gallery",
    "itemUrl":    "https://open-vsx.org/vscode/item",
    "latestUrlTemplate": "https://open-vsx.org/vscode/gallery/{publisher}/{name}/latest",
    "resourceUrlTemplate": "https://open-vsx.org/vscode/unpkg/{publisher}/{name}/{version}/{path}",
    "controlUrl": "https://raw.githubusercontent.com/EclipseFdn/publish-extensions/refs/heads/master/extension-control/extensions.json",
    "recommendationsUrl": ""
  }
| .linkProtectionTrustedDomains = ["https://open-vsx.org"]

# No telemetry / AI / Copilot product hooks. An OSS build has none by default;
# deleting them makes that explicit so a later upstream merge that adds one
# shows up as a conflict here rather than silently shipping.
| .enableTelemetry = false
| del(.aiConfig)
| del(.telemetryOptOutUrl)
# A neutral defaultChatAgent rather than deleting the key.
#
# Deleting it is the obvious move — every value in it is a GitHub/Copilot
# identifier or URL. But the workbench treats the key as required in ~20 places,
# including `toDefaultAccountConfig` which reads `provider.default.id` two levels
# deep, so removing it means either patching all of them or shipping a build that
# throws on startup. An all-empty stub carries no Microsoft strings and keeps
# every one of those call sites type- and runtime-correct.
| .defaultChatAgent = {
    "extensionId": "",
    "chatExtensionId": "",
    "chatExtensionOutputId": "",
    "chatExtensionOutputExtensionStateCommand": "",
    "documentationUrl": "",
    "skusDocumentationUrl": "",
    "optimizeUsageDocumentationUrl": "",
    "publicCodeMatchesUrl": "",
    "managePlanUrl": "",
    "upgradePlanUrl": "",
    "signUpUrl": "",
    "termsStatementUrl": "",
    "privacyStatementUrl": "",
    "provider": {
      "default":    { "id": "", "name": "" },
      "enterprise": { "id": "", "name": "" },
      "google":     { "id": "", "name": "" },
      "apple":      { "id": "", "name": "" },
      "microsoft":  { "id": "", "name": "" }
    },
    "providerExtensionId": "",
    "providerUriSetting": "",
    "providerScopes": [],
    "entitlementUrl": "",
    "entitlementSignupLimitedUrl": "",
    "tokenEntitlementUrl": "",
    "mcpRegistryDataUrl": "",
    "managedSettingsUrl": "",
    "chatQuotaExceededContext": "",
    "completionsQuotaExceededContext": "",
    "walkthroughCommand": "",
    "completionsMenuCommand": "",
    "chatRefreshTokenCommand": "",
    "generateCommitMessageCommand": "",
    "resolveMergeConflictsCommand": "",
    "completionsAdvancedSetting": "",
    "completionsEnablementSetting": "",
    "nextEditSuggestionsSetting": ""
  }
| del(.agentsTelemetryAppName)
| del(.voiceWsUrl)
| del(.chatParticipantRegistry)
| del(.chatSessionRecommendations)
| del(.trustedExtensionAuthAccess)
| del(.updateUrl)
| del(.downloadUrl)
| del(.documentationUrl)
| del(.introductoryVideosUrl)
| del(.tipsAndTricksUrl)
| del(.newsletterSignupUrl)
| del(.twitterUrl)
| del(.requestFeatureUrl)
| del(.privacyStatementUrl)
| del(.checksumFailMoreInfoUrl)
| del(.nlsCoreBaseUrl)
| del(.extensionTips)
| del(.extensionImportantTips)
| del(.keymapExtensionTips)
| del(.languageExtensionTips)
| del(.exeBasedExtensionTips)
| del(.configBasedExtensionTips)
| del(.webExtensionTips)
| del(.virtualWorkspaceExtensionTips)
| del(.emergencyAlertUrl)
| del(.authClientIdMetadataUrl)
| del(.["configurationSync.store"])
| del(.["editSessions.store"])
| .tunnelApplicationConfig = {}
| .webviewContentExternalBaseUrlTemplate = ""
| .serverLicenseUrl = "https://github.com/BimaPDev/HivemindIDE-editor/blob/main/LICENSE.txt"

# No Copilot auto-update hook. Upstream lists GitHub.copilot-chat here so the
# scanner can refresh a built-in Copilot VSIX; we ship none. The scanner
# iterates this array unconditionally, so it has to stay an empty list.
| .builtInExtensionsEnabledWithAutoUpdates = []

# Bundle Catppuccin as an optional alternative theme. The defaults are the
# in-tree Hivemind lens themes (extensions/theme-hivemind in the fork)
# with the monochrome vscode-modern-icons, so nothing here is load-bearing for
# the default look — dropping these entries only removes the choice.
#
# These are fetched at build time from .extensionsGallery.serviceUrl (Open VSX,
# set above) by `npm run download-builtin-extensions`. sha256 pins the exact
# artifact — if upstream republishes a version, the build fails loudly rather
# than silently shipping different code.
# Keep upstream ms-vscode.js-debug* — those are MIT and required for debugging.
| .builtInExtensions = (
    ((.builtInExtensions // [])
      | map(select(
          (.name | startswith("Catppuccin.") | not)
          and (.name | startswith("GitHub.copilot") | not)
          and (.name | test("ms-vscode\\.vscode-speech|ms-vscode\\.copilot") | not)
        )))
    + [
      {
        "name": "Catppuccin.catppuccin-vsc",
        "version": "3.19.0",
        "sha256": "ebf347664837edbe91c9920ff3d14c96d4a28beeec0b95137c76058326329780",
        "repo": "https://github.com/catppuccin/vscode",
        "metadata": {
          "id": "69264e4d-cd3b-468a-8f2b-e69673c7d864",
          "publisherId": {
            "publisherId": "e7d2ed61-53e0-4dd4-afbe-f536c3bb4316",
            "publisherName": "Catppuccin",
            "displayName": "Catppuccin",
            "flags": "verified"
          },
          "publisherDisplayName": "Catppuccin"
        }
      },
      {
        "name": "Catppuccin.catppuccin-vsc-icons",
        "version": "1.26.0",
        "sha256": "57566136d0a8ba8d040eb6e5be866c88ccbb04f3d219d3a7e52a19978900ff3d",
        "repo": "https://github.com/catppuccin/vscode-icons",
        "metadata": {
          "id": "625b9abd-dfac-405b-bf34-e65f46e2f22f",
          "publisherId": {
            "publisherId": "e7d2ed61-53e0-4dd4-afbe-f536c3bb4316",
            "publisherName": "Catppuccin",
            "displayName": "Catppuccin",
            "flags": "verified"
          },
          "publisherDisplayName": "Catppuccin"
        }
      }
    ]
  )

| .reportIssueUrl = "https://github.com/BimaPDev/HivemindIDE-editor/issues/new"
| .licenseUrl     = "https://github.com/BimaPDev/HivemindIDE-editor/blob/main/LICENSE.txt"

# First-run theme picker: Dynamic (the default) first, then one card per
# single-lens theme, plus Light.
| .onboardingThemes = [
    { id: "hivemind-dynamic", label: "Hivemind Dynamic", themeId: "Hivemind Dynamic", type: "dark" },
    { id: "hivemind-ember",  label: "Hivemind Ember",  themeId: "Hivemind Ember",  type: "dark" },
    { id: "hivemind-jade",   label: "Hivemind Jade",   themeId: "Hivemind Jade",   type: "dark" },
    { id: "hivemind-cobalt", label: "Hivemind Cobalt", themeId: "Hivemind Cobalt", type: "dark" },
    { id: "hivemind-violet", label: "Hivemind Violet", themeId: "Hivemind Violet", type: "dark" },
    { id: "hivemind-chrome", label: "Hivemind Chrome", themeId: "Hivemind Chrome", type: "dark" },
    { id: "hivemind-light",  label: "Hivemind Light",  themeId: "Hivemind Light",  type: "light" }
  ]
' "$EDITOR_DIR/product.json" > "$EDITOR_DIR/product.json.tmp"
mv "$EDITOR_DIR/product.json.tmp" "$EDITOR_DIR/product.json"

# ---------------------------------------------------------------------------
# package.json — product name, author
# ---------------------------------------------------------------------------
log "branding package.json"
# Two-space, not tabs: package.json's own style. Mismatching it reformats all
# 660 lines and turns every upstream package.json change into a conflict.
jq '
  .name    = "hivemindide"
| .author = { "name": "HivemindIDE" }

# Drop Copilot from the default compile/watch graph. The extension directory
# may still exist on disk (upstream tree), but `npm run compile` must not try
# to build it — and we do not need @github/copilot at the repo root.
| .scripts.compile          = "npm run compile-client"
| .scripts.watch            = "npm-run-all2 -lp watch-client-transpile watch-client watch-extensions"
| .scripts["watch-transpile"] = "npm-run-all2 -lp watch-client-transpile watch-extensions"
| del(.scripts["compile-copilot"])
| del(.scripts["watch-copilot"])
| del(.scripts["watch-copilotd"])
| del(.scripts["kill-watch-copilotd"])
| del(.scripts["copilot:setup"])
| del(.scripts["copilot:get_token"])
| del(.dependencies["@github/copilot"])
| del(.dependencies["@vscode/copilot-api"])
# Keep @github/copilot-sdk. gulpfile.vscode.ts reads its package.json at
# startup (getCopilotRuntimeVersion) before any task runs, so deleting the
# dependency makes `npm run compile` fail before it compiles anything.
' "$EDITOR_DIR/package.json" > "$EDITOR_DIR/package.json.tmp"
mv "$EDITOR_DIR/package.json.tmp" "$EDITOR_DIR/package.json"

# Drop Microsoft Corporation from Electron metadata (about dialog / crash
# reporter attribution) the same way VSCodium does.
if [ -f "$EDITOR_DIR/build/lib/electron.ts" ]; then
	"${SED_INPLACE[@]}" 's|Microsoft Corporation|HivemindIDE|g' "$EDITOR_DIR/build/lib/electron.ts"
	"${SED_INPLACE[@]}" 's|([0-9]) Microsoft|\1 HivemindIDE|g' "$EDITOR_DIR/build/lib/electron.ts"
fi

# ---------------------------------------------------------------------------
# Source defaults — VSCodium's 00-telemetry-disable.patch, as idempotent sed
# ---------------------------------------------------------------------------
log "disabling Microsoft online-service defaults"

TELEMETRY_TS="$EDITOR_DIR/src/vs/platform/telemetry/common/telemetryService.ts"
if [ -f "$TELEMETRY_TS" ]; then
	# telemetry.telemetryLevel → off
	"${SED_INPLACE[@]}" \
		"s/'default': TelemetryConfiguration\.ON,/'default': TelemetryConfiguration.OFF,/" \
		"$TELEMETRY_TS"
	# deprecated telemetry.enableTelemetry → false
	perl -i -0pe "s/(\[TELEMETRY_OLD_SETTING_ID\]:\s*\{.*?'default':\s*)true/\${1}false/s" \
		"$TELEMETRY_TS"
	# feedback / surveys off by default
	perl -i -0pe "s/(telemetry\.feedback\.enabled':\s*\{[^}]*?default:\s*)true/\${1}false/s" \
		"$TELEMETRY_TS"
fi

# Crash reporter, experiments, natural-language search (Microsoft online services)
if [ -f "$EDITOR_DIR/src/vs/workbench/electron-browser/desktop.contribution.ts" ]; then
	perl -i -0pe "s/(telemetry\.enableCrashReporting[^\}]*?'default':\s*)true/\${1}false/s" \
		"$EDITOR_DIR/src/vs/workbench/electron-browser/desktop.contribution.ts"
fi
if [ -f "$EDITOR_DIR/src/vs/workbench/services/assignment/common/assignmentService.ts" ]; then
	perl -i -0pe "s/(workbench\.enableExperiments[^\}]*?'default':\s*)true/\${1}false/s" \
		"$EDITOR_DIR/src/vs/workbench/services/assignment/common/assignmentService.ts"
fi
if [ -f "$EDITOR_DIR/src/vs/workbench/contrib/preferences/common/preferencesContribution.ts" ]; then
	perl -i -0pe "s/(enableNaturalLanguageSettingsSearch[^\}]*?'default':\s*)true/\${1}false/s" \
		"$EDITOR_DIR/src/vs/workbench/contrib/preferences/common/preferencesContribution.ts"
fi
if [ -f "$EDITOR_DIR/src/vs/workbench/browser/workbench.contribution.ts" ]; then
	perl -i -0pe "s/(enableNaturalLanguageSearch[^\}]*?'default':\s*)true/\${1}false/s" \
		"$EDITOR_DIR/src/vs/workbench/browser/workbench.contribution.ts"
fi
if [ -f "$EDITOR_DIR/src/vs/workbench/contrib/editTelemetry/browser/editTelemetry.contribution.ts" ]; then
	perl -i -0pe 's/(EDIT_TELEMETRY_SETTING_ID\]:\s*\{[^}]*?default:\s*)true/$1false/s' \
		"$EDITOR_DIR/src/vs/workbench/contrib/editTelemetry/browser/editTelemetry.contribution.ts"
fi

# Copilot welcome copy: providers is undefined once defaultChatAgent is stripped.
if [ -f "$EDITOR_DIR/src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts" ]; then
	"${SED_INPLACE[@]}" 's/providers\.default\.name/providers?.default?.name/g' \
		"$EDITOR_DIR/src/vs/workbench/contrib/chat/browser/widget/chatWidget.ts"
fi

# ---------------------------------------------------------------------------
# Drop Copilot + Microsoft account auth from the npm / packaging graph
# ---------------------------------------------------------------------------
log "excluding Copilot and Microsoft authentication from the build"
DIRS_TS="$EDITOR_DIR/build/npm/dirs.ts"
if [ -f "$DIRS_TS" ]; then
	"${SED_INPLACE[@]}" "/'extensions\/copilot',/d" "$DIRS_TS"
	"${SED_INPLACE[@]}" "/'extensions\/microsoft-authentication',/d" "$DIRS_TS"
fi

# npm dirs skip the extension, but the dev compile list is a hardcoded array
# in gulpfile.extensions.ts. Leaving the entry in makes `npm run compile`
# typecheck an extension whose node_modules were never installed.
GULP_EXT="$EDITOR_DIR/build/gulpfile.extensions.ts"
if [ -f "$GULP_EXT" ]; then
	"${SED_INPLACE[@]}" "/'extensions\/microsoft-authentication\/tsconfig.json',/d" "$GULP_EXT"
fi

# Packaging still walks extensions/ even when npm dirs skip them. Keep
# microsoft-authentication out of the VSIX/product payload the same way
# upstream already excludes 'copilot'.
EXT_LIB="$EDITOR_DIR/build/lib/extensions.ts"
if [ -f "$EXT_LIB" ]; then
	"${SED_INPLACE[@]}" "/^[[:space:]]*'microsoft-authentication',[[:space:]]*$/d" "$EXT_LIB"
	if ! grep -q "'microsoft-authentication'" "$EXT_LIB"; then
		perl -i -0pe "s/(const excludedExtensions = \[\n\t'copilot',)/\$1\n\t'microsoft-authentication',/" "$EXT_LIB"
	fi
fi

# ---------------------------------------------------------------------------
# Hide Copilot setup UI when no chat agent extension is configured
# ---------------------------------------------------------------------------
# The empty defaultChatAgent stub is truthy, so ChatEntitlementService would
# otherwise still spin up GitHub entitlement requests and leave chatSetupHidden
# false — which surfaces "Sign in to use GitHub Copilot" across welcome,
# accounts, and the chat setup menus. Treat a missing chatExtensionId like
# "unsupported on web": hide setup and bail before entitlement work.
log "hiding Copilot setup when chatExtensionId is empty"
ENTITLEMENT_TS="$EDITOR_DIR/src/vs/workbench/services/chat/common/chatEntitlementService.ts"
if [ -f "$ENTITLEMENT_TS" ]; then
	perl -i -0pe 's/if \(!productService\.defaultChatAgent\) \{\n\t\t\treturn; \/\/ we need a default chat agent configured going forward from here\n\t\t\}/if (!productService.defaultChatAgent?.chatExtensionId) {\n\t\t\tChatEntitlementContextKeys.Setup.hidden.bindTo(this.contextKeyService).set(true); \/\/ no Copilot agent configured\n\t\t\treturn;\n\t\t}/' \
		"$ENTITLEMENT_TS"
fi

# Drop Copilot Voice from the workbench import graph. Entitlement-gated already,
# but with no Copilot agent there is nothing for it to do and the contribution
# still registers Copilot-branded chrome.
WB_MAIN="$EDITOR_DIR/src/vs/workbench/workbench.common.main.ts"
if [ -f "$WB_MAIN" ]; then
	"${SED_INPLACE[@]}" \
		's|^import '\''\./contrib/agentsVoice/browser/agentsVoice\.contribution\.js'\'';|// import '\''./contrib/agentsVoice/browser/agentsVoice.contribution.js'\''; // HivemindIDE: no Copilot Voice|' \
		"$WB_MAIN"
fi

# Dev fallback in product.ts still injects GitHub.copilot IDs when the baked
# product blob is empty (web/out-of-sources edge case). Neutralize it so a
# missing product.json never reintroduces Copilot.
PRODUCT_TS="$EDITOR_DIR/src/vs/platform/product/common/product.ts"
if [ -f "$PRODUCT_TS" ]; then
	perl -i -0pe "s/extensionId:\s*'GitHub\.copilot'/extensionId: ''/g; s/chatExtensionId:\s*'GitHub\.copilot-chat'/chatExtensionId: ''/g" \
		"$PRODUCT_TS"
	# Stop reading @github/copilot versions from package.json once those deps are gone.
	if grep -q "@github/copilot" "$PRODUCT_TS"; then
		perl -i -0pe "s/\n\tif \(!product\.copilotVersions\) \{.*?\n\t\}\n/\n/s" \
			"$PRODUCT_TS"
	fi
	# Dead helper once the copilotVersions block is gone.
	if grep -q "function getDependencyVersion" "$PRODUCT_TS"; then
		# Definition itself matches getDependencyVersion(; only remove when that is the sole hit.
		if [ "$(grep -c "getDependencyVersion(" "$PRODUCT_TS" || true)" -eq 1 ]; then
			perl -i -0pe 's/\nfunction getDependencyVersion\(.*?\n\}\n/\n/s' \
				"$PRODUCT_TS"
		fi
	fi
fi

# ---------------------------------------------------------------------------
# Neutre hard-coded telemetry hosts (VSCodium undo_telemetry.sh)
# ---------------------------------------------------------------------------
HIVEMINDIDE_EDITOR_DIR="$EDITOR_DIR" "$SCRIPT_DIR/undo_telemetry.sh"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
log "done"
jq -r '
  "  nameLong          \(.nameLong)",
  "  applicationName   \(.applicationName)",
  "  dataFolderName    \(.dataFolderName)",
  "  bundle id         \(.darwinBundleIdentifier)",
  "  gallery           \(.extensionsGallery.serviceUrl)",
  "  enableTelemetry   \(.enableTelemetry)",
  "  chatExtensionId   \(.defaultChatAgent.chatExtensionId // "(none)")",
  "  copilotAutoUpdate \(.builtInExtensionsEnabledWithAutoUpdates // "(stripped)")",
  "  voiceWsUrl        \(.voiceWsUrl // "(stripped)")",
  "  bundled           \([.builtInExtensions[].name] | join(", "))"
' "$EDITOR_DIR/product.json"
