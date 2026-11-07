# The demo Cardboard: its own profile and library, and its Claude Code (the person's own agent, provider "claude")
# talking to the stand-in on 127.0.0.1 with a placeholder key and a fresh config folder, so the user's own sign-in is
# never read or sent. The Director is left alone (Cardboard points it at its own gateway whatever the environment says).
# Not --mute-audio: OBS records the voices through Application Audio Capture.
#   powershell -ExecutionPolicy Bypass -File start-cardboard.ps1
. "$PSScriptRoot\demo-env.ps1"
$env:CARDBOARD_USER_DATA = $UserData
$env:CARDBOARD_HOME = $Library
$env:CARDBOARD_CLAUDE_PATH = $Claude
$env:CLAUDE_CONFIG_DIR = $ClaudeCfg
$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$Port"
$env:ANTHROPIC_API_KEY = "sk-mock"
$env:CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1"
$env:DISABLE_AUTOUPDATER = "1"
Remove-Item Env:ANTHROPIC_AUTH_TOKEN -ErrorAction SilentlyContinue
Start-Process -FilePath $Exe
