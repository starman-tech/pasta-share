package main

// Protocole de transfert sur un canal de données (identique côté navigateur) :
// {"type":"meta",name,size,mime} → morceaux binaires → {"type":"done"} → le receveur répond {"type":"ok"}.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"
)

func notify(msg string) {
	exec.Command("notify-send", "-a", "Pasta", "Pasta 🍝", msg).Run()
}

// receive enregistre les fichiers envoyés par un téléphone dans le dossier de téléchargement
func (d *daemon) receive(sl *slot, dc *webrtc.DataChannel) {
	var f *os.File
	var x *xfer
	var name, tmp string
	var got int64
	fail := func(msg string) {
		if f != nil {
			f.Close()
			os.Remove(tmp)
			f = nil
		}
		if x != nil && x.Status == "progress" {
			d.finish(x, errors.New(msg))
		}
	}
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if !msg.IsString {
			if f != nil {
				f.Write(msg.Data)
				got += int64(len(msg.Data))
				d.progress(x, got)
			}
			return
		}
		var m struct {
			Type, Name string
			Size       int64
		}
		if json.Unmarshal(msg.Data, &m) != nil {
			return
		}
		switch m.Type {
		case "meta":
			os.MkdirAll(d.cfg.Dir, 0o755)
			name = uniqueName(d.cfg.Dir, safeName(m.Name))
			tmp = filepath.Join(d.cfg.Dir, "."+name+".part")
			f, _ = os.Create(tmp)
			got = 0
			x = d.newXfer("in", name, m.Size, d.phoneName(sl))
		case "done":
			if f == nil {
				return
			}
			f.Close()
			f = nil
			dst := filepath.Join(d.cfg.Dir, name)
			os.Rename(tmp, dst)
			x.path = dst
			d.finish(x, nil)
			dc.SendText(`{"type":"ok"}`)
			log.Println("reçu :", name)
			go notify("Reçu : " + name)
		}
	})
	dc.OnClose(func() { fail("Interrompu") })
}

func safeName(s string) string {
	s = filepath.Base(strings.ReplaceAll(s, "\\", "/"))
	if s == "." || s == ".." || s == "/" {
		return "fichier"
	}
	return s
}

func uniqueName(dir, name string) string {
	ext := filepath.Ext(name)
	base := strings.TrimSuffix(name, ext)
	for i, cand := 1, name; ; i++ {
		if _, err := os.Stat(filepath.Join(dir, cand)); os.IsNotExist(err) {
			return cand
		}
		cand = fmt.Sprintf("%s (%d)%s", base, i, ext)
	}
}

// source : un fichier à envoyer, lu sur le disque (pasta send) ou reçu de l'appli PC
type source struct {
	name string
	size int64
	r    io.Reader
}

// channel ouvre un canal de données vers un téléphone connecté
type channel struct {
	dc   *webrtc.DataChannel
	low  chan struct{}
	acks chan struct{}
}

func (d *daemon) openChannel(sl *slot) (*channel, error) {
	d.mu.Lock()
	pc, on := sl.pc, sl.online
	d.mu.Unlock()
	if pc == nil || !on {
		return nil, errors.New("téléphone hors ligne")
	}
	dc, err := pc.CreateDataChannel("pasta", nil)
	if err != nil {
		return nil, err
	}
	ch := &channel{dc: dc, low: make(chan struct{}, 1), acks: make(chan struct{}, 1)}
	opened := make(chan struct{})
	dc.OnOpen(func() { close(opened) })
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if m.IsString && strings.Contains(string(m.Data), `"ok"`) {
			select {
			case ch.acks <- struct{}{}:
			default:
			}
		}
	})
	dc.SetBufferedAmountLowThreshold(1 << 20)
	dc.OnBufferedAmountLow(func() {
		select {
		case ch.low <- struct{}{}:
		default:
		}
	})
	select {
	case <-opened:
		return ch, nil
	case <-time.After(10 * time.Second):
		dc.Close()
		return nil, errors.New("canal impossible à ouvrir")
	}
}

// send envoie un fichier et attend la confirmation du téléphone
func (d *daemon) send(ch *channel, src source, x *xfer) error {
	meta, _ := json.Marshal(map[string]any{
		"type": "meta", "name": src.name, "size": src.size,
		"mime": mime.TypeByExtension(filepath.Ext(src.name)),
	})
	if err := ch.dc.SendText(string(meta)); err != nil {
		return err
	}
	buf := make([]byte, 16*1024)
	var sent int64
	for {
		k, err := io.ReadFull(src.r, buf)
		if k > 0 {
			for ch.dc.BufferedAmount() > 8<<20 {
				select {
				case <-ch.low:
				case <-time.After(100 * time.Millisecond):
				}
				if ch.dc.ReadyState() != webrtc.DataChannelStateOpen {
					return errors.New("connexion perdue")
				}
			}
			chunk := make([]byte, k)
			copy(chunk, buf[:k])
			if err := ch.dc.Send(chunk); err != nil {
				return err
			}
			sent += int64(k)
			d.progress(x, sent)
		}
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			break
		}
		if err != nil {
			return err
		}
	}
	if err := ch.dc.SendText(`{"type":"done"}`); err != nil {
		return err
	}
	select {
	case <-ch.acks:
		return nil
	case <-time.After(60 * time.Second):
		return errors.New("pas de confirmation de réception")
	}
}

// sendPaths envoie des fichiers du disque à un téléphone (utilisé par « pasta send »)
func (d *daemon) sendPaths(sl *slot, paths []string) error {
	ch, err := d.openChannel(sl)
	if err != nil {
		return err
	}
	defer ch.dc.Close()
	for _, p := range paths {
		f, err := os.Open(p)
		if err != nil {
			return err
		}
		st, err := f.Stat()
		if err != nil || st.IsDir() {
			f.Close()
			return fmt.Errorf("%s n'est pas un fichier", p)
		}
		x := d.newXfer("out", filepath.Base(p), st.Size(), d.phoneName(sl))
		err = d.send(ch, source{filepath.Base(p), st.Size(), f}, x)
		f.Close()
		d.finish(x, err)
		if err != nil {
			return err
		}
	}
	return nil
}
