#!/bin/sh
# celld-ts-check socket 激活安装（需 root）
set -e
cp celld-ts-check-relay.py /usr/local/bin/
chmod 755 /usr/local/bin/celld-ts-check-relay.py
cp systemd/celld-ts-check.socket systemd/celld-ts-check.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now celld-ts-check.socket
echo "socket 已启用："
systemctl status celld-ts-check.socket --no-pager | head -4
