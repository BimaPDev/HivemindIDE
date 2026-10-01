# Launch the fork from source on Windows.
# macOS and Linux: ./fork/run.sh
#
# Finds the Node version pinned in hivemindide-editor/.nvmrc (nvm-windows, fnm,
# volta, or node on PATH), then runs fork/run.mjs, which starts scripts/code.bat.
$ErrorActionPreference = 'Stop'

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo = Split-Path -Parent $ScriptDir
if ($env:HIVEMINDIDE_EDITOR_DIR) {
	$Editor = $env:HIVEMINDIDE_EDITOR_DIR
} else {
	$Editor = Join-Path $Repo 'hivemindide-editor'
}
if (-not (Test-Path -LiteralPath $Editor)) {
	Write-Error "no checkout at $Editor"
	exit 1
}

$version = ''
$nvmrc = Join-Path $Editor '.nvmrc'
if (Test-Path -LiteralPath $nvmrc) {
	$version = (Get-Content -LiteralPath $nvmrc -TotalCount 1).Trim().TrimStart('v', 'V')
}

# The real profile, not a HOME an agent shell may have redirected.
try {
	$accountHome = [Environment]::GetFolderPath('UserProfile')
} catch {
	$accountHome = $env:USERPROFILE
}

function Test-PinnedNode([string]$bin) {
	if (-not $bin -or -not (Test-Path -LiteralPath $bin)) { return $false }
	if (-not $version) { return $true }
	$got = (& $bin -v 2>$null)
	return "$got".Trim() -eq "v$version"
}

$candidates = @()
if ($version) {
	$nvmHome = $env:NVM_HOME
	if (-not $nvmHome -and $env:APPDATA) { $nvmHome = Join-Path $env:APPDATA 'nvm' }
	if ($nvmHome) {
		$candidates += (Join-Path $nvmHome "v$version\node.exe")
		$candidates += (Join-Path $nvmHome "$version\node.exe")
	}
	$fnmRoots = @($env:FNM_DIR)
	if ($env:LOCALAPPDATA) { $fnmRoots += (Join-Path $env:LOCALAPPDATA 'fnm') }
	if ($accountHome) {
		$fnmRoots += (Join-Path $accountHome 'AppData\Local\fnm')
		$fnmRoots += (Join-Path $accountHome '.fnm')
		$candidates += (Join-Path $accountHome ".volta\tools\image\node\$version\node.exe")
	}
	foreach ($root in $fnmRoots) {
		if ($root) {
			$candidates += (Join-Path $root "node-versions\v$version\installation\node.exe")
		}
	}
	if ($env:ProgramFiles) {
		$candidates += (Join-Path $env:ProgramFiles 'nodejs\node.exe')
	}
}
$onPath = Get-Command node -ErrorAction SilentlyContinue
if ($onPath) { $candidates += $onPath.Source }

$node = $null
foreach ($bin in $candidates) {
	if (Test-PinnedNode $bin) { $node = $bin; break }
}
if (-not $node -and $onPath) {
	Write-Warning "node $version not found; using $($onPath.Source)"
	$node = $onPath.Source
}
if (-not $node) {
	Write-Error "node is required. Install Node $version (hivemindide-editor/.nvmrc) and re-run."
	exit 1
}

& $node (Join-Path $ScriptDir 'run.mjs') @args
exit $LASTEXITCODE
