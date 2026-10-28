package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/mdp/qrterminal/v3"
)

const usage = `🍝 Pasta Share

  pasta pair               affiche un QR code pour appairer un téléphone
  pasta send <fichiers…>   envoie des fichiers à tes téléphones
  pasta daemon             récepteur (lancé automatiquement au démarrage)
  pasta uninstall          désinstalle tout

  Appli PC : http://localhost:47801`

func main() {
	log.SetFlags(0)
	if len(os.Args) < 2 {
		fmt.Println(usage)
		os.Exit(1)
	}
	switch os.Args[1] {
	case "pair":
		runPair()
	case "daemon":
		runDaemon()
	case "send":
		runSend(os.Args[2:])
	case "uninstall":
		runUninstall()
	default:
		fmt.Println(usage)
		os.Exit(1)
	}
}

func runPair() {
	link, err := addPairing()
	if err != nil {
		log.Fatal(err)
	}
	fmt.Print("\nScanne ce QR code avec l'appareil photo de ton téléphone (même Wi-Fi que ce PC) :\n\n")
	qrterminal.GenerateHalfBlock(link, qrterminal.L, os.Stdout)
	fmt.Println(link)
}

// runSend confie les fichiers au récepteur, qui détient les connexions avec les téléphones
func runSend(args []string) {
	if len(args) == 0 {
		log.Fatal("usage : pasta send <fichiers…>")
	}
	var paths []string
	for _, a := range args {
		p, err := filepath.Abs(a)
		if err != nil {
			fail(err.Error())
		}
		paths = append(paths, p)
	}
	c := loadConfig()
	if len(c.Secrets) == 0 {
		fail("Aucun téléphone appairé. Lance d'abord : pasta pair")
	}
	body, _ := json.Marshal(map[string]any{"paths": paths})
	req, _ := http.NewRequest("POST", fmt.Sprintf("http://127.0.0.1:%d/api/send", apiPort), bytes.NewReader(body))
	req.Header.Set("X-Pasta-Token", c.Token)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		fail("Le récepteur Pasta ne tourne pas : systemctl --user start pasta")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		fail(res.Status)
	}
	// lancé depuis le clic droit, il n'y a pas de terminal : on tient l'utilisateur au courant par notifications
	sc := bufio.NewScanner(res.Body)
	last := ""
	var names []string
	for sc.Scan() {
		last = sc.Text()
		fmt.Println(strings.TrimPrefix(last, "ERR "))
		switch {
		case strings.HasPrefix(last, "En attente"):
			notify("Ouvre Pasta sur ton téléphone pour recevoir")
		case strings.HasPrefix(last, "→ "):
			names = append(names, strings.TrimPrefix(last, "→ "))
		}
	}
	if strings.HasPrefix(last, "ERR ") {
		fail(strings.TrimPrefix(last, "ERR "))
	}
	if last == "OK" {
		notify(fmt.Sprintf("%d élément(s) envoyé(s) à %s ✓", len(paths), strings.Join(names, ", ")))
	}
}

func fail(msg string) {
	notify(msg)
	log.Fatal(msg)
}

func runUninstall() {
	exec.Command("systemctl", "--user", "disable", "--now", "pasta").Run()
	home, _ := os.UserHomeDir()
	os.Remove(filepath.Join(home, ".config/systemd/user/pasta.service"))
	os.Remove(filepath.Join(home, ".local/share/nautilus/scripts/Envoyer avec Pasta"))
	os.Remove(filepath.Join(home, ".local/share/applications/pasta-share.desktop"))
	os.Remove(filepath.Join(home, ".local/share/icons/pasta-share.png"))
	os.RemoveAll(configDir())
	if exe, err := os.Executable(); err == nil {
		os.Remove(exe)
	}
	fmt.Println("Pasta a été désinstallé. À bientôt 🍝")
}
