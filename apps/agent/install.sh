#!/usr/bin/env bash
set -euo pipefail
SERVER_URL="${SERVER_URL:-http://localhost:4000}"
ENROLLMENT_SECRET="${ENROLLMENT_SECRET:-change-me-enrollment-secret}"
INSTALL_DIR="${INSTALL_DIR:-/opt/pc-manager-agent}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

sudo mkdir -p "$INSTALL_DIR"

# Helper first when its binary is present. Agent-only install is unchanged otherwise.
HELPER_INSTALLED=0
HELPER_SRC="${SCRIPT_DIR}/pc-manager-helper"
if [[ ! -f "$HELPER_SRC" ]]; then
  HELPER_SRC="${SCRIPT_DIR}/dist/pc-manager-helper-linux-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
fi
if [[ -f "$HELPER_SRC" ]]; then
  echo "Installing watchdog helper first..."
  if sudo cp "$HELPER_SRC" "$INSTALL_DIR/pc-manager-helper" && sudo chmod +x "$INSTALL_DIR/pc-manager-helper"; then
    if [[ ! -f "$INSTALL_DIR/helper.yaml" ]]; then
      sudo tee "$INSTALL_DIR/helper.yaml" >/dev/null <<EOF
agent_service_name: pc-manager-agent
status_port: 17890
backoff_sec: 30
EOF
    fi
    sudo tee /etc/systemd/system/pc-manager-helper.service >/dev/null <<EOF
[Unit]
Description=Mnag.pt Helper
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${INSTALL_DIR}/pc-manager-helper run
Restart=always
RestartSec=5
Environment=PC_MANAGER_HELPER_CONFIG=${INSTALL_DIR}/helper.yaml

[Install]
WantedBy=multi-user.target
EOF
    HELPER_INSTALLED=1
  else
    echo "WARNING: helper install failed; continuing with agent-only" >&2
  fi
fi

BIN_SRC="${SCRIPT_DIR}/pc-manager-agent"
if [[ ! -x "$BIN_SRC" ]]; then
  BIN_SRC="${SCRIPT_DIR}/dist/pc-manager-agent-linux-$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')"
fi
sudo cp "$BIN_SRC" "$INSTALL_DIR/pc-manager-agent"
sudo chmod +x "$INSTALL_DIR/pc-manager-agent"

if [[ ! -f "$INSTALL_DIR/config.yaml" ]]; then
  sudo tee "$INSTALL_DIR/config.yaml" >/dev/null <<EOF
server_url: ${SERVER_URL}
fallback_urls: []
enrollment_secret: ${ENROLLMENT_SECRET}
heartbeat_interval_sec: 30
poll_interval_sec: 15
status_port: 17890
EOF
fi

sudo tee /etc/systemd/system/pc-manager-agent.service >/dev/null <<EOF
[Unit]
Description=Mnag.pt Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${INSTALL_DIR}/pc-manager-agent run
Restart=always
RestartSec=5
Environment=PC_MANAGER_CONFIG=${INSTALL_DIR}/config.yaml

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
if [[ "$HELPER_INSTALLED" -eq 1 ]]; then
  sudo systemctl enable --now pc-manager-helper || echo "WARNING: helper start failed; continuing with agent" >&2
fi
sudo systemctl enable --now pc-manager-agent
echo "Installed Mnag.pt Agent. Edit ${INSTALL_DIR}/config.yaml then: sudo systemctl restart pc-manager-agent"
if [[ "$HELPER_INSTALLED" -eq 1 ]]; then
  echo "Installed Mnag.pt Helper watchdog. Edit ${INSTALL_DIR}/helper.yaml then: sudo systemctl restart pc-manager-helper"
fi
