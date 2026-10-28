package main

// Le récepteur : un port UDP fixe sur lequel chaque téléphone appairé se connecte directement.
// Pour chaque appairage, une connexion WebRTC « armée » attend, avec une offre du téléphone
// reconstituée à l'avance (identifiants dérivés du secret). Dès qu'une session se termine,
// on en arme une nouvelle.

import (
	"encoding/json"
	"log"
	"net"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/pion/ice/v4"
	"github.com/pion/webrtc/v4"
)

type slot struct {
	secret string
	cr     creds
	pc     *webrtc.PeerConnection
	ctl    *webrtc.DataChannel
	online bool
	gone   bool // appairage oublié
}

type daemon struct {
	cfg       *Config
	cert      webrtc.Certificate
	mux       ice.UDPMux
	mu        sync.Mutex
	slots     map[string]*slot // secret → slot
	transfers []*xfer
	nextID    int
	hub       *hub
	changed   chan struct{}
}

type xfer struct {
	ID     int    `json:"id"`
	Dir    string `json:"dir"` // in | out
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	Done   int64  `json:"done"`
	Status string `json:"status"` // progress | done | error
	Peer   string `json:"peer"`
	Msg    string `json:"msg,omitempty"`
	path   string
	last   time.Time
}

func runDaemon() {
	c := loadConfig()
	cert, err := certificate()
	if err != nil {
		log.Fatal("certificat : ", err)
	}
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{Port: c.Port})
	if err != nil {
		log.Fatalf("port UDP %d indisponible : %v", c.Port, err)
	}
	d := &daemon{
		cfg: c, cert: *cert, mux: webrtc.NewICEUDPMux(nil, conn),
		slots: map[string]*slot{}, hub: newHub(), changed: make(chan struct{}, 1),
	}
	d.sync()
	go d.watchConfig()
	log.Printf("🍝 Pasta prêt : téléphones sur UDP %d, appli PC sur http://localhost:%d", c.Port, apiPort)
	log.Fatal(d.serveAPI())
}

// sync aligne les slots sur la liste des secrets de la config
func (d *daemon) sync() {
	d.mu.Lock()
	want := map[string]bool{}
	for _, s := range d.cfg.Secrets {
		want[s] = true
		if d.slots[s] == nil {
			sl := &slot{secret: s, cr: credsOf(s)}
			d.slots[s] = sl
			go d.arm(sl)
		}
	}
	var drop []*slot
	for s, sl := range d.slots {
		if !want[s] {
			sl.gone = true
			drop = append(drop, sl)
			delete(d.slots, s)
		}
	}
	d.mu.Unlock()
	for _, sl := range drop {
		if sl.pc != nil {
			sl.pc.Close()
		}
	}
	d.stateChanged()
}

func (d *daemon) watchConfig() {
	mod := func() time.Time {
		st, err := os.Stat(configPath())
		if err != nil {
			return time.Time{}
		}
		return st.ModTime()
	}
	last := mod()
	for range time.Tick(2 * time.Second) {
		if m := mod(); !m.Equal(last) {
			last = m
			c := loadConfig()
			d.mu.Lock()
			d.cfg.Secrets, d.cfg.Phones, d.cfg.Name, d.cfg.Dir = c.Secrets, c.Phones, c.Name, c.Dir
			d.mu.Unlock()
			d.sync()
		}
	}
}

// offre SDP du téléphone, reconstituée : seuls ses identifiants ICE comptent (empreinte non vérifiée,
// l'authentification repose sur les mots de passe ICE dérivés du secret)
func phoneOffer(cr creds) string {
	return strings.Join([]string{
		"v=0", "o=- 1 1 IN IP4 0.0.0.0", "s=-", "t=0 0", "a=group:BUNDLE 0", "a=msid-semantic: WMS",
		"m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "c=IN IP4 0.0.0.0",
		"a=ice-ufrag:" + cr.phUfrag, "a=ice-pwd:" + cr.phPwd, "a=ice-options:trickle",
		"a=fingerprint:sha-256 " + strings.TrimSuffix(strings.Repeat("00:", 32), ":"),
		"a=setup:actpass", "a=mid:0", "a=sctp-port:5000", "a=max-message-size:262144", "",
	}, "\r\n")
}

func (d *daemon) arm(sl *slot) {
	se := webrtc.SettingEngine{}
	se.SetICEUDPMux(d.mux)
	se.SetLite(true)
	se.SetICECredentials(sl.cr.pcUfrag, sl.cr.pcPwd)
	se.DisableCertificateFingerprintVerification(true)
	se.SetAnsweringDTLSRole(webrtc.DTLSRoleServer)
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	se.SetICETimeouts(8*time.Second, 12*time.Second, 2*time.Second)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(se))
	pc, err := api.NewPeerConnection(webrtc.Configuration{Certificates: []webrtc.Certificate{d.cert}})
	if err != nil {
		log.Println("connexion :", err)
		return
	}
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		switch dc.Label() {
		case "ctl":
			d.onCtl(sl, pc, dc)
		case "pasta":
			d.receive(sl, dc)
		}
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		switch st {
		case webrtc.PeerConnectionStateConnected:
			d.setOnline(sl, pc, true)
		case webrtc.PeerConnectionStateDisconnected, webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed:
			d.rearm(sl, pc)
		}
	})
	err = pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: phoneOffer(sl.cr)})
	if err == nil {
		var ans webrtc.SessionDescription
		if ans, err = pc.CreateAnswer(nil); err == nil {
			err = pc.SetLocalDescription(ans)
		}
	}
	if err != nil {
		log.Println("préparation de la connexion :", err)
		pc.Close()
		return
	}
	d.mu.Lock()
	if sl.gone {
		d.mu.Unlock()
		pc.Close()
		return
	}
	sl.pc, sl.ctl, sl.online = pc, nil, false
	d.mu.Unlock()
}

// rearm termine la session et en prépare une nouvelle (une seule fois par connexion)
func (d *daemon) rearm(sl *slot, pc *webrtc.PeerConnection) {
	d.mu.Lock()
	if sl.pc != pc {
		d.mu.Unlock()
		return
	}
	sl.pc, sl.online = nil, false
	gone := sl.gone
	d.mu.Unlock()
	d.stateChanged()
	go func() {
		pc.Close()
		if !gone {
			time.Sleep(300 * time.Millisecond)
			d.arm(sl)
		}
	}()
}

func (d *daemon) setOnline(sl *slot, pc *webrtc.PeerConnection, on bool) {
	d.mu.Lock()
	if sl.pc == pc {
		sl.online = on
	}
	d.mu.Unlock()
	d.stateChanged()
}

// canal de contrôle : on échange les noms, et le PC donne ses adresses à jour
func (d *daemon) onCtl(sl *slot, pc *webrtc.PeerConnection, dc *webrtc.DataChannel) {
	d.mu.Lock()
	if sl.pc == pc {
		sl.ctl = dc
	}
	d.mu.Unlock()
	dc.OnOpen(func() { d.hello(dc) })
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		var msg struct{ Type, Name string }
		if json.Unmarshal(m.Data, &msg) != nil || msg.Type != "hello" || msg.Name == "" {
			return
		}
		d.mu.Lock()
		changed := d.cfg.Phones[sl.secret] != msg.Name
		d.cfg.Phones[sl.secret] = msg.Name
		d.mu.Unlock()
		if changed {
			d.saveConfig()
		}
		d.stateChanged()
	})
}

func (d *daemon) hello(dc *webrtc.DataChannel) {
	b, _ := json.Marshal(map[string]any{"type": "hello", "name": d.cfg.Name, "ips": lanIPs(), "host": mdnsHost()})
	dc.SendText(string(b))
}

func (d *daemon) saveConfig() {
	c := loadConfig()
	d.mu.Lock()
	c.Phones, c.Name = d.cfg.Phones, d.cfg.Name
	d.mu.Unlock()
	c.save()
}

func (d *daemon) phoneName(sl *slot) string {
	if n := d.cfg.Phones[sl.secret]; n != "" {
		return n
	}
	return "Téléphone"
}

// ---------- état et transferts, diffusés à l'appli PC ----------

type phoneInfo struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Online bool   `json:"online"`
}

func (d *daemon) state() map[string]any {
	d.mu.Lock()
	defer d.mu.Unlock()
	phones := []phoneInfo{}
	for _, s := range d.cfg.Secrets {
		// un appairage n'apparaît qu'une fois que le téléphone s'est connecté (QR scanné)
		if sl := d.slots[s]; sl != nil && (sl.online || d.cfg.Phones[s] != "") {
			phones = append(phones, phoneInfo{sl.cr.id, d.phoneName(sl), sl.online})
		}
	}
	return map[string]any{"name": d.cfg.Name, "phones": phones}
}

func (d *daemon) stateChanged() {
	d.hub.emit("state", d.state())
	select {
	case d.changed <- struct{}{}:
	default:
	}
}

func (d *daemon) online() []*slot {
	d.mu.Lock()
	defer d.mu.Unlock()
	var out []*slot
	for _, s := range d.cfg.Secrets {
		if sl := d.slots[s]; sl != nil && sl.online {
			out = append(out, sl)
		}
	}
	return out
}

func (d *daemon) slotByID(id string) *slot {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, sl := range d.slots {
		if sl.cr.id == id {
			return sl
		}
	}
	return nil
}

func (d *daemon) newXfer(dir, name string, size int64, peer string) *xfer {
	d.mu.Lock()
	d.nextID++
	x := &xfer{ID: d.nextID, Dir: dir, Name: name, Size: size, Status: "progress", Peer: peer}
	d.transfers = append(d.transfers, x)
	if len(d.transfers) > 100 {
		d.transfers = d.transfers[1:]
	}
	d.mu.Unlock()
	d.hub.emit("transfer", x)
	return x
}

// progress publie l'avancement, au plus ~6 fois par seconde
func (d *daemon) progress(x *xfer, done int64) {
	d.mu.Lock()
	x.Done = done
	emit := time.Since(x.last) > 150*time.Millisecond
	if emit {
		x.last = time.Now()
	}
	d.mu.Unlock()
	if emit {
		d.hub.emit("transfer", x)
	}
}

func (d *daemon) finish(x *xfer, err error) {
	d.mu.Lock()
	if err != nil {
		x.Status, x.Msg = "error", err.Error()
	} else {
		x.Status, x.Done = "done", x.Size
	}
	d.mu.Unlock()
	d.hub.emit("transfer", x)
}

func (d *daemon) xferByID(id int) *xfer {
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, x := range d.transfers {
		if x.ID == id {
			return x
		}
	}
	return nil
}

// waitOnline attend qu'au moins un téléphone soit connecté
func (d *daemon) waitOnline(max time.Duration) []*slot {
	deadline := time.After(max)
	for {
		if on := d.online(); len(on) > 0 {
			return on
		}
		select {
		case <-d.changed:
		case <-time.After(time.Second):
		case <-deadline:
			return nil
		}
	}
}
