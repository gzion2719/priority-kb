# PriorityKB local-dev pg_dump backup stub (M1 L20).
# See docs/runbooks/backup.md for invocation, scheduling, and the M5 plan
# (compression + retention + object storage + restore drill).
#
# Strategy: pg_dump runs INSIDE the docker container (no local Postgres
# client required) and writes to /tmp/<stamp>.sql; docker cp pulls the
# file out byte-for-byte (avoids PowerShell 5.1's default UTF-16 BOM
# encoding clobbering the dump on stdout pipelines).

$ErrorActionPreference = 'Stop'

$Container = if ($env:PRIORITY_KB_DB_CONTAINER) { $env:PRIORITY_KB_DB_CONTAINER } else { 'priority-kb-db' }
$DbUser    = if ($env:PRIORITY_KB_DB_USER)      { $env:PRIORITY_KB_DB_USER }      else { 'postgres' }
$DbName    = if ($env:PRIORITY_KB_DB_NAME)      { $env:PRIORITY_KB_DB_NAME }      else { 'priority_kb' }
$OutDir    = if ($env:PRIORITY_KB_BACKUP_DIR)   { $env:PRIORITY_KB_BACKUP_DIR }   else { Join-Path $PSScriptRoot '..\backups' }

$Stamp        = Get-Date -Format 'yyyyMMdd-HHmmss'
$ContainerOut = "/tmp/priority_kb-$Stamp.sql"
$OutFile      = Join-Path $OutDir "priority_kb-$Stamp.sql"

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }

# Container-running precheck — fail fast with a clear message instead of
# a confusing docker-exec error.
$running = docker inspect -f '{{.State.Running}}' $Container 2>$null
if ($LASTEXITCODE -ne 0 -or $running -ne 'true') {
    throw "Container '$Container' is not running. Start it with: docker compose up -d db"
}

docker exec $Container pg_dump -U $DbUser -d $DbName --no-owner --clean --if-exists -f $ContainerOut
if ($LASTEXITCODE -ne 0) {
    throw "pg_dump failed inside container '$Container' (exit $LASTEXITCODE)"
}

docker cp "${Container}:$ContainerOut" $OutFile
if ($LASTEXITCODE -ne 0) {
    throw "docker cp failed copying ${Container}:$ContainerOut -> $OutFile (exit $LASTEXITCODE)"
}

# Best-effort container-side cleanup (don't fail the run if this trips).
docker exec $Container rm -f $ContainerOut 2>$null | Out-Null

$size = (Get-Item $OutFile).Length
Write-Host "Backup written: $OutFile ($size bytes)"
