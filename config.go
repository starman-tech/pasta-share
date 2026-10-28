package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"
)

// adresse de l'appli web (téléphone), utilisée dans les liens d'appairage
const defaultServer = "https://starman-tech.github.io/pasta-share"

type Config struct {
	Server  string            `json:"server"`
	Name    string            `json:"name"`
	Dir     string            `json:"dir"`
	Port    int               `json:"port"`  // UDP : connexions directes des téléphones
	Token   string            `json:"token"` // protège l'API locale utilisée par « pasta send »
	Secrets []string          `json:"secrets"`
	Phones  map[string]string `json:"phones"` // secret → nom du téléphone appairé
}

func configDir() string {
	d, _ := os.UserConfigDir()
	return filepath.Join(d, "pasta")
}

func configPath() string { return filepath.Join(configDir(), "config.json") }

func loadConfig() *Config {
	c := &Config{}
	if b, err := os.ReadFile(configPath()); err == nil {
		json.Unmarshal(b, c)
	}
	dirty := false
	if c.Token == "" {
		c.Token, dirty = randomToken(24), true
	}
	// anciennes versions : serveur local sur le port 8080
	if c.Server == "" || strings.Contains(c.Server, "localhost") || strings.HasSuffix(c.Server, ":8080") {
		c.Server, dirty = defaultServer, true
	}
	if c.Name == "" {
		c.Name, _ = os.Hostname()
	}
	if c.Dir == "" {
		c.Dir = downloadDir()
	}
	if c.Port == 0 {
		c.Port = 47800
	}
	if c.Phones == nil {
		c.Phones = map[string]string{}
	}
	if dirty {
		c.save()
	}
	return c
}

func (c *Config) save() error {
	os.MkdirAll(configDir(), 0o700)
	b, _ := json.MarshalIndent(c, "", "  ")
	tmp := configPath() + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, configPath())
}

// certificate renvoie le certificat DTLS de ce PC, créé une fois pour toutes : son empreinte
// est dans le QR code, c'est ce qui permet au téléphone de se connecter sans intermédiaire.
func certificate() (*webrtc.Certificate, error) {
	path := filepath.Join(configDir(), "cert.pem")
	if b, err := os.ReadFile(path); err == nil {
		return webrtc.CertificateFromPEM(string(b))
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}
	serial, _ := rand.Int(rand.Reader, big.NewInt(1<<62))
	cert, err := webrtc.NewCertificate(key, x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: "pasta"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(30, 0, 0),
	})
	if err != nil {
		return nil, err
	}
	pem, err := cert.PEM()
	if err != nil {
		return nil, err
	}
	os.MkdirAll(configDir(), 0o700)
	return cert, os.WriteFile(path, []byte(pem), 0o600)
}

func downloadDir() string {
	if out, err := exec.Command("xdg-user-dir", "DOWNLOAD").Output(); err == nil {
		if d := strings.TrimSpace(string(out)); d != "" {
			return d
		}
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, "Downloads")
}

func randomToken(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}
