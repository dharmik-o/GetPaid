#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu server (Oracle Cloud Always Free Arm VM): Docker, Node 22, git,
# and the VM's own firewall opened for web traffic (ports 80 and 443). Safe to run again: it only
# does what is missing, and says what it did.
#   bash deploy/server-setup.sh
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "Run this as your normal user (for example ubuntu), not as root. It uses sudo where it must." >&2
  exit 1
fi

did=()
note() { did+=("$1"); }
export DEBIAN_FRONTEND=noninteractive

sudo apt-get update -qq
sudo apt-get install -y -qq git curl ca-certificates iptables-persistent >/dev/null
note "checked packages: git, curl, iptables-persistent"

if ! command -v docker >/dev/null 2>&1; then
  # Docker's own installer (https://docs.docker.com/engine/install/ubuntu/#install-using-the-convenience-script).
  curl -fsSL https://get.docker.com | sudo sh
  note "installed Docker"
fi
if ! id -nG "$USER" | grep -qw docker; then
  sudo usermod -aG docker "$USER"
  note "added $USER to the docker group (log out and back in for it to apply)"
fi

if ! node -v 2>/dev/null | grep -q '^v22\.'; then
  # NodeSource's installer for the Node 22 line. Node is only used for migrations and scripts.
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs >/dev/null
  note "installed Node $(node -v)"
fi

# Oracle's Ubuntu images block ports 80 and 443 in the VM itself. Also open them in the cloud
# network's security list (docs/DEPLOY.md, step 1).
changed_firewall=0
for port in 80 443; do
  if ! sudo iptables -C INPUT -m state --state NEW -p tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport "$port" -j ACCEPT
    note "opened port $port in the VM firewall"
    changed_firewall=1
  fi
done
if [ "$changed_firewall" -eq 1 ]; then
  sudo netfilter-persistent save >/dev/null
  note "saved the firewall rules so they survive a reboot"
fi

echo
echo "Server setup finished."
if [ "${#did[@]}" -eq 0 ]; then
  echo "- nothing to do: everything was already in place"
else
  printf -- '- %s\n' "${did[@]}"
fi
echo "Docker $(docker --version | cut -d' ' -f3 | tr -d ,), Node $(node -v), git $(git --version | cut -d' ' -f3)"
