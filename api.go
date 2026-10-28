package main

// API locale (127.0.0.1 uniquement) : sert l'appli PC (installable, localhost étant un contexte
// sécurisé) et permet à « pasta send » de confier des fichiers au récepteur.

import (
	"bufio"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"os/exec"
	"slices"
	"strconv"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
	"rsc.io/qr"
)

const apiPort = 47801

//go:embed docs
var assets embed.FS

type hub struct {
	mu   sync.Mutex
	subs map[chan []byte]bool
}

func newHub() *hub { return &hub{subs: map[chan []byte]bool{}} }

func (h *hub) emit(event string, v any) {
	b, _ := json.Marshal(v)
	msg := []byte(fmt.Sprintf("event: %s\ndata: %s\n\n", event, b))
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.subs {
		select {
		case c <- msg:
		default:
		}
	}
}

// local refuse les requêtes venues d'un autre site (seule l'appli servie ici, ou un outil sans Origin)
func local(next http.HandlerFunc) http.HandlerFunc {
	allowed := []string{"", fmt.Sprintf("http://localhost:%d", apiPort), fmt.Sprintf("http://127.0.0.1:%d", apiPort)}
	return func(w http.ResponseWriter, r *http.Request) {
		if !slices.Contains(allowed, r.Header.Get("Origin")) {
			http.Error(w, "origine refusée", http.StatusForbidden)
			return
		}
		next(w, r)
	}
}

func (d *daemon) serveAPI() error {
	mime.AddExtensionType(".webmanifest", "application/manifest+json")
	mime.AddExtensionType(".woff2", "font/woff2")
	web, _ := fs.Sub(assets, "docs")
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.FS(web)))

	mux.HandleFunc("GET /api/events", local(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		c := make(chan []byte, 64)
		d.hub.mu.Lock()
		d.hub.subs[c] = true
		d.hub.mu.Unlock()
		defer func() { d.hub.mu.Lock(); delete(d.hub.subs, c); d.hub.mu.Unlock() }()
		write := func(event string, v any) {
			b, _ := json.Marshal(v)
			fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, b)
		}
		write("state", d.state())
		d.mu.Lock()
		for _, x := range d.transfers {
			write("transfer", x)
		}
		d.mu.Unlock()
		w.(http.Flusher).Flush()
		ping := time.NewTicker(20 * time.Second)
		defer ping.Stop()
		for {
			select {
			case msg := <-c:
				w.Write(msg)
			case <-ping.C:
				fmt.Fprint(w, ": ping\n\n")
			case <-r.Context().Done():
				return
			}
			w.(http.Flusher).Flush()
		}
	}))

	// envoi depuis l'appli PC : le corps de la requête est le fichier, transmis au fil de l'eau
	mux.HandleFunc("POST /api/upload", local(func(w http.ResponseWriter, r *http.Request) {
		sl := d.slotByID(r.URL.Query().Get("to"))
		name := safeName(r.URL.Query().Get("name"))
		if sl == nil {
			http.Error(w, "appareil inconnu", http.StatusNotFound)
			return
		}
		ch, err := d.openChannel(sl)
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		defer ch.dc.Close()
		x := d.newXfer("out", name, r.ContentLength, d.phoneName(sl))
		err = d.send(ch, source{name, r.ContentLength, r.Body}, x)
		d.finish(x, err)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
		}
	}))

	// pasta send : fichiers du disque vers tous les téléphones connectés (attend jusqu'à 10 min)
	mux.HandleFunc("POST /api/send", local(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Pasta-Token") != d.cfg.Token {
			http.Error(w, "jeton invalide", http.StatusForbidden)
			return
		}
		var req struct{ Paths []string }
		if json.NewDecoder(r.Body).Decode(&req) != nil || len(req.Paths) == 0 {
			http.Error(w, "aucun fichier", http.StatusBadRequest)
			return
		}
		items, cleanup, err := prepare(req.Paths)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		defer cleanup()
		out := bufio.NewWriter(w)
		say := func(s string) { out.WriteString(s + "\n"); out.Flush(); w.(http.Flusher).Flush() }
		targets := d.online()
		if len(targets) == 0 {
			say("En attente… ouvre Pasta sur ton téléphone (Ctrl+C pour annuler)")
			if targets = d.waitOnline(10 * time.Minute); len(targets) == 0 {
				say("ERR Aucun appareil en ligne, envoi annulé.")
				return
			}
		}
		ok := true
		for _, sl := range targets {
			say("→ " + d.phoneName(sl))
			if err := d.sendPaths(sl, items); err != nil {
				say(fmt.Sprintf("ERR Échec vers %s : %v", d.phoneName(sl), err))
				ok = false
			}
		}
		if ok {
			say("OK")
		}
	}))

	mux.HandleFunc("POST /api/pair", local(func(w http.ResponseWriter, r *http.Request) {
		link, err := addPairing()
		if err != nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}
		c := loadConfig()
		d.mu.Lock()
		d.cfg.Secrets = c.Secrets
		d.mu.Unlock()
		d.sync()
		json.NewEncoder(w).Encode(map[string]string{"link": link})
	}))

	mux.HandleFunc("GET /api/qr", local(func(w http.ResponseWriter, r *http.Request) {
		code, err := qr.Encode(r.URL.Query().Get("d"), qr.M)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		code.Scale = 8
		w.Header().Set("Content-Type", "image/png")
		w.Write(code.PNG())
	}))

	mux.HandleFunc("POST /api/forget", local(func(w http.ResponseWriter, r *http.Request) {
		sl := d.slotByID(r.URL.Query().Get("id"))
		if sl == nil {
			http.Error(w, "appareil inconnu", http.StatusNotFound)
			return
		}
		c := loadConfig()
		c.Secrets = slices.DeleteFunc(c.Secrets, func(s string) bool { return s == sl.secret })
		delete(c.Phones, sl.secret)
		c.save()
		d.mu.Lock()
		d.cfg.Secrets, d.cfg.Phones = c.Secrets, c.Phones
		d.mu.Unlock()
		d.sync()
	}))

	mux.HandleFunc("POST /api/name", local(func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Name string }
		if json.NewDecoder(r.Body).Decode(&req) != nil || req.Name == "" {
			http.Error(w, "nom manquant", http.StatusBadRequest)
			return
		}
		d.mu.Lock()
		d.cfg.Name = req.Name
		var ctls []*webrtc.DataChannel
		for _, sl := range d.slots {
			if sl.ctl != nil {
				ctls = append(ctls, sl.ctl)
			}
		}
		d.mu.Unlock()
		d.saveConfig()
		for _, dc := range ctls {
			d.hello(dc)
		}
		d.stateChanged()
	}))

	// ouvre un fichier reçu, ou le dossier de téléchargement
	mux.HandleFunc("POST /api/open", local(func(w http.ResponseWriter, r *http.Request) {
		target := d.cfg.Dir
		if id, err := strconv.Atoi(r.URL.Query().Get("id")); err == nil {
			if x := d.xferByID(id); x != nil && x.path != "" {
				target = x.path
			}
		}
		exec.Command("xdg-open", target).Start()
	}))

	return http.ListenAndServe(fmt.Sprintf("127.0.0.1:%d", apiPort), mux)
}

// addPairing crée un nouveau secret et renvoie le lien à ouvrir sur le téléphone
func addPairing() (string, error) {
	c := loadConfig()
	fp, err := fingerprintHex()
	if err != nil {
		return "", err
	}
	secret := randomToken(32)
	c.Secrets = append(c.Secrets, secret)
	if err := c.save(); err != nil {
		return "", err
	}
	return pairLink(c, secret, fp), nil
}
