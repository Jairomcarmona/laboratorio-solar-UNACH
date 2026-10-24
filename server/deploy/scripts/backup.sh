#!/bin/sh
# Respaldo diario comprimido de la base y borrado de respaldos con más de RETENTION_DAYS días. Corre dentro del contenedor "backup".
set -eu
RETENTION_DAYS="${RETENTION_DAYS:-30}"
while true; do
  f="/backups/labsolar_$(date -u +%Y%m%dT%H%M%SZ).dump"
  pg_dump -Fc -f "$f.tmp" && mv "$f.tmp" "$f" && echo "respaldo $f ($(du -h "$f" | cut -f1))"
  find /backups -name 'labsolar_*.dump' -mtime +"$RETENTION_DAYS" -print -delete
  sleep 86400
done
