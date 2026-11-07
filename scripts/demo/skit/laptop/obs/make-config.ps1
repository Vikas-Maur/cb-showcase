# make-config.ps1: our own OBS settings for the demo recording, in OBS's portable config folder
# (E:\OBS\obs-studio\config\obs-studio, read only when OBS starts with --portable), so the user's own OBS settings in
# %APPDATA%\obs-studio (their profile "Untitled", their collection "Untitled", their last-used choices) are never read
# or written by our runs. Writes:
#   global.ini, user.ini                 no update check, no exit confirmation, first run done, tray on
#   basic\profiles\CardboardDemo\basic.ini   Simple output: NVENC, "High Quality, Medium File Size", hybrid MP4,
#                                         AAC 192k, into D:\OBS, 1920x1080 at 60 fps, 48 kHz stereo
#   basic\scenes\CardboardDemo.json      scene "Cardboard": Window Capture of Cardboard.exe (Windows Graphics Capture,
#                                         matched by executable, client area, no cursor) fitted to 1920x1080, and
#                                         Application Audio Capture of Cardboard.exe; no Desktop Audio, no Mic
param([string]$Root = 'E:\OBS\obs-studio\config\obs-studio')
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force "$Root\basic\profiles\CardboardDemo", "$Root\basic\scenes" | Out-Null
$enc = New-Object System.Text.UTF8Encoding($false)
[IO.File]::WriteAllText("$Root\global.ini", @"
[General]
MaxLogs=10
InfoIncrement=-1
ProcessPriority=Normal
EnableAutoUpdates=false

[Video]
Renderer=Direct3D 11

[Audio]
DisableAudioDucking=true
"@, $enc)
[IO.File]::WriteAllText("$Root\user.ini", @"
[General]
Pre19Defaults=false
Pre21Defaults=false
Pre23Defaults=false
Pre24.1Defaults=false
ConfirmOnExit=false
FirstRun=true

[BasicWindow]
SysTrayEnabled=true
SysTrayWhenStarted=false
WarnBeforeStartingStream=false
WarnBeforeStoppingStream=false
WarnBeforeStoppingRecord=false

[Basic]
Profile=CardboardDemo
ProfileDir=CardboardDemo
SceneCollection=CardboardDemo
SceneCollectionFile=CardboardDemo.json
ConfigOnNewProfile=false
"@, $enc)
[IO.File]::WriteAllText("$Root\basic\profiles\CardboardDemo\basic.ini", @"
[General]
Name=CardboardDemo

[Output]
Mode=Simple
FilenameFormatting=skit-%CCYY-%MM-%DD_%hh-%mm-%ss

[SimpleOutput]
FilePath=D:/OBS
RecFormat2=hybrid_mp4
VBitrate=6000
ABitrate=192
UseAdvanced=false
NVENCPreset2=p5
RecQuality=HQ
RecRB=false
StreamAudioEncoder=aac
RecAudioEncoder=aac
RecTracks=1
StreamEncoder=nvenc
RecEncoder=nvenc

[Video]
BaseCX=1920
BaseCY=1080
OutputCX=1920
OutputCY=1080
FPSType=0
FPSCommon=60
ScaleType=bicubic
ColorFormat=NV12
ColorSpace=709
ColorRange=Partial

[Audio]
SampleRate=48000
ChannelSetup=Stereo
"@, $enc)
$wc = [guid]::NewGuid().ToString(); $ac = [guid]::NewGuid().ToString(); $sc = [guid]::NewGuid().ToString()
$hot = @{ 'libobs.mute' = @(); 'libobs.unmute' = @(); 'libobs.push-to-mute' = @(); 'libobs.push-to-talk' = @() }
$src = { param($name, $uuid, $id, $settings) [ordered]@{ prev_ver = 536936450; name = $name; uuid = $uuid; id = $id; versioned_id = $id; settings = $settings; mixers = 255; sync = 0; flags = 0; volume = 1.0; balance = 0.5; enabled = $true; muted = $false; 'push-to-mute' = $false; 'push-to-mute-delay' = 0; 'push-to-talk' = $false; 'push-to-talk-delay' = 0; hotkeys = $hot; deinterlace_mode = 0; deinterlace_field_order = 0; monitoring_type = 0; private_settings = @{} } }
# window: "<title>:<class>:<exe>" (priority 2: match the executable, whatever the title); method 2: Windows Graphics Capture
$win = 'Cardboard:Chrome_WidgetWin_1:Cardboard.exe'
$item = { param($name, $uuid, $id, $bounds) [ordered]@{ name = $name; source_uuid = $uuid; visible = $true; locked = $false; rot = 0.0; scale_ref = @{ x = 1920.0; y = 1080.0 }; align = 5; bounds_type = $(if ($bounds) { 2 } else { 0 }); bounds_align = 0; bounds_crop = $false; crop_left = 0; crop_top = 0; crop_right = 0; crop_bottom = 0; id = $id; group_item_backup = $false; pos = @{ x = 0.0; y = 0.0 }; scale = @{ x = 1.0; y = 1.0 }; bounds = $(if ($bounds) { @{ x = 1920.0; y = 1080.0 } } else { @{ x = 0.0; y = 0.0 } }); scale_filter = 'disable'; blend_method = 'default'; blend_type = 'normal'; show_transition = @{ duration = 300 }; hide_transition = @{ duration = 300 }; private_settings = @{} } }
$scene = & $src 'Cardboard' $sc 'scene' ([ordered]@{ id_counter = 2; custom_size = $false; items = @((& $item 'Cardboard window' $wc 1 $true), (& $item 'Cardboard audio' $ac 2 $false)) })
$col = [ordered]@{
  name = 'CardboardDemo'
  sources = @(
    (& $src 'Cardboard window' $wc 'window_capture' ([ordered]@{ window = $win; priority = 2; method = 2; cursor = $false; client_area = $true; force_sdr = $false })),
    (& $src 'Cardboard audio' $ac 'wasapi_process_output_capture' ([ordered]@{ window = $win; priority = 2 })),
    $scene)
  groups = @(); scene_order = @(@{ name = 'Cardboard' }); current_scene = 'Cardboard'; current_program_scene = 'Cardboard'
  current_transition = 'Fade'; transition_duration = 300; transitions = @(); quick_transitions = @(); saved_projectors = @()
  preview_locked = $false; scaling_enabled = $false; scaling_level = 0; scaling_off_x = 0.0; scaling_off_y = 0.0; modules = @{}
}
[IO.File]::WriteAllText("$Root\basic\scenes\CardboardDemo.json", ($col | ConvertTo-Json -Depth 10), $enc)
Get-ChildItem -Recurse $Root -File | Select-Object FullName, Length
