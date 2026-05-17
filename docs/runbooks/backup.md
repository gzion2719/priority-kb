# Backup runbook — local dev pg_dump stub (M1 L20)

Local-dev backup procedure for the PriorityKB Postgres container. This
is the **M1 stub** — script + scheduled-task registration only. Production
backups (compression, 30-day retention, S3-compatible object storage,
restore drill) all land in M5 per `docs/ROADMAP.md` L117–L118.

## What it does

[`scripts/backup-db.ps1`](../../scripts/backup-db.ps1) runs `pg_dump`
inside the `priority-kb-db` docker container, then `docker cp`s the
result out to `backups/priority_kb-YYYYMMDD-HHmmss.sql`. Running inside
the container avoids needing a local Postgres client install; using
`docker cp` (instead of piping pg_dump's stdout to a PowerShell file)
sidesteps PowerShell 5.1's default UTF-16 BOM encoding clobbering the
dump.

## Where files land

Backups are written to `backups/` at the repo root. The directory is
**gitignored** — only `backups/.gitkeep` is tracked. `.sql` dumps stay
local to your machine.

## One-shot invocation

```powershell
cd "C:\Users\galzi\OneDrive - Afiki-C\Development\Claude\PriorityKB"
docker compose up -d db          # ensure container is running
powershell -File scripts\backup-db.ps1
```

Override defaults via env vars:

| Var | Default | Notes |
|-----|---------|-------|
| `PRIORITY_KB_DB_CONTAINER` | `priority-kb-db` | Container name from `docker-compose.yml` |
| `PRIORITY_KB_DB_USER` | `postgres` | Matches compose plaintext dev creds |
| `PRIORITY_KB_DB_NAME` | `priority_kb` | Compose `POSTGRES_DB` |
| `PRIORITY_KB_BACKUP_DIR` | `<repo>\backups` | Resolved relative to the script |

## Schedule it (Windows Task Scheduler)

Register a daily 02:00 run. The repo path lives under OneDrive (spaces +
hyphens), so the `/TR` value must be **double-quoted with inner `\"`
escapes** or `schtasks` truncates the path at the first space.

```powershell
schtasks /Create /SC DAILY /TN "PriorityKB-Backup" /ST 02:00 /TR "powershell -NoProfile -ExecutionPolicy Bypass -File \"C:\Users\galzi\OneDrive - Afiki-C\Development\Claude\PriorityKB\scripts\backup-db.ps1\""
```

Inspect / unregister:

```powershell
schtasks /Query /TN "PriorityKB-Backup" /V /FO LIST
schtasks /Delete /TN "PriorityKB-Backup" /F
```

The container must be running at trigger time. If you stop docker
overnight, schedule the docker-compose-up before the backup, or skip the
backup with a precheck — the script itself fails fast with a clear
message if the container is down.

## Restore (manual; full drill deferred to M5)

```powershell
docker exec -i priority-kb-db psql -U postgres -d priority_kb < backups\priority_kb-<stamp>.sql
```

`--clean --if-exists` in the dump means the restore drops + recreates
objects idempotently, so running against an existing DB is safe.

## What's NOT in this stub (M5 will add)

- Compression (`pg_dump -Fc` or pipe through gzip)
- 30-day retention with old-file pruning
- Upload to S3-compatible object storage (Azure Blob if hosting on
  Azure)
- Automated restore drill in CI / staging
- Secrets in a managed vault (currently env-var defaults match the
  plaintext dev creds in `docker-compose.yml`)
