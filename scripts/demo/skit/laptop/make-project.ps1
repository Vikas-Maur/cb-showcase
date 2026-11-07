# The promo, made in the demo library with Cardboard's own cb (titles and code graphics only: no footage).
#   powershell -ExecutionPolicy Bypass -File make-project.ps1
. "$PSScriptRoot\demo-env.ps1"
cb project create $Project
cb source apply $Project (Join-Path $Skit "promo.tsx")
cb source print $Project | Select-Object -First 14
