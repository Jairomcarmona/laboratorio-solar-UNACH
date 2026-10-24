#!/usr/bin/env bash
# Genera deploy/mosquitto/passwd con una contraseña aleatoria por servicio y las imprime en formato .env.
# Uso: ./gen-passwd.sh > ../secrets.env   (no subir secrets.env al repositorio)
set -euo pipefail
cd "$(dirname "$0")"
rm -f passwd; touch passwd
for u in bridge gateway recorder twin daq; do
  p="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
  mosquitto_passwd -b passwd "$u" "$p"
  echo "MQTT_PASSWORD_$(echo "$u" | tr a-z A-Z)=$p"
done
chmod 600 passwd
