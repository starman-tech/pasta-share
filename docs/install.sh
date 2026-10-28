#!/bin/sh
# Installe le récepteur Pasta Share (sans sudo)
set -e
DL="https://github.com/starman-tech/pasta-share/releases/latest/download"

case "$(uname -m)" in
  x86_64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) echo "Architecture non supportée : $(uname -m)"; exit 1 ;;
esac

BIN="$HOME/.local/bin/pasta"
mkdir -p "$HOME/.local/bin" "$HOME/.config/systemd/user"
echo "🍝 Téléchargement de Pasta…"
# fichier temporaire puis renommage : on ne peut pas écraser un binaire en cours d'exécution
curl -fsSL "$DL/pasta-linux-$ARCH" -o "$BIN.new"
chmod +x "$BIN.new"
mv -f "$BIN.new" "$BIN"

cat > "$HOME/.config/systemd/user/pasta.service" <<EOF
[Unit]
Description=Pasta Share - réception de fichiers
After=network-online.target

[Service]
ExecStart=$BIN daemon
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

NS="$HOME/.local/share/nautilus/scripts"
mkdir -p "$NS"
printf '#!/bin/sh\nexec "%s" send "$@"\n' "$BIN" > "$NS/Envoyer avec Pasta"
chmod +x "$NS/Envoyer avec Pasta"

# lanceur dans le menu des applications : ouvre l'appli PC (QR code d'appairage, envoi, journal)
APPS="$HOME/.local/share/applications"
mkdir -p "$APPS" "$HOME/.local/share/icons"
curl -fsSL "https://starman-tech.github.io/pasta-share/icon-512.png" -o "$HOME/.local/share/icons/pasta-share.png" || true
cat > "$APPS/pasta-share.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Pasta Share
Comment=Envoyer des fichiers entre ton téléphone et ce PC
Exec=xdg-open http://localhost:47801
Icon=$HOME/.local/share/icons/pasta-share.png
Categories=Network;FileTransfer;
EOF

systemctl --user daemon-reload
systemctl --user enable pasta
systemctl --user restart pasta

echo "✅ Installé ! Ouvre « Pasta Share » dans tes applications (ou http://localhost:47801)"
sleep 1
"$BIN" pair
