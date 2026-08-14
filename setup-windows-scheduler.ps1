# Kuromoon Windows Task Scheduler Setup Script
# Schedules run-local-pipeline.bat at 09:00 AM and 18:00 (06:00 PM) daily.

$BatPath = "c:\Users\ggamy\OneDrive\Desktop\S_Kuromoon\run-local-pipeline.bat"

$Action = New-ScheduledTaskAction -Execute $BatPath -WorkingDirectory "c:\Users\ggamy\OneDrive\Desktop\S_Kuromoon\web"
$TriggerMorning = New-ScheduledTaskTrigger -Daily -At 9:00AM
$TriggerEvening = New-ScheduledTaskTrigger -Daily -At 6:00PM
$Settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable

Register-ScheduledTask -TaskName "Kuromoon_Local_Pipeline" -Action $Action -Trigger @($TriggerMorning, $TriggerEvening) -Settings $Settings -Description "Runs Kuromoon data collection, AI refinement, and SSG build locally at 09:00 AM and 06:00 PM daily." -Force

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "✅ 'Kuromoon_Local_Pipeline' Registered Successfully!" -ForegroundColor Green
Write-Host "   - Schedule: Daily at 09:00 AM and 06:00 PM" -ForegroundColor Yellow
Write-Host "   - Action: $BatPath" -ForegroundColor Yellow
Write-Host "========================================================" -ForegroundColor Cyan
