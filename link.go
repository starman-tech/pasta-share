package main

// Appairage sans intermédiaire : tout ce qu'il faut pour se connecter tient dans le QR code.
// Les identifiants ICE des deux côtés sont dérivés du secret partagé, l'empreinte du
// certificat du PC est fixe et le PC écoute toujours sur le même port UDP. Le téléphone peut
// donc fabriquer seul la réponse SDP du PC (même calcul dans docs/app.js).

import (
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
)

type creds struct {
	id             string // identifiant public de l'appairage
	pcUfrag, pcPwd string
	phUfrag, phPwd string
}

func derive(secret, label string, n int) string {
	h := sha256.Sum256([]byte("pasta-" + label + ":" + secret))
	return hex.EncodeToString(h[:])[:n]
}

func credsOf(secret string) creds {
	return creds{
		id:      derive(secret, "id", 12),
		pcUfrag: derive(secret, "pc-ufrag", 16), pcPwd: derive(secret, "pc-pwd", 32),
		phUfrag: derive(secret, "ph-ufrag", 16), phPwd: derive(secret, "ph-pwd", 32),
	}
}

// lanIPs liste les adresses IPv4 du PC sur le réseau local (sans Docker ni interfaces virtuelles)
func lanIPs() []string {
	var ips []string
	ifaces, _ := net.Interfaces()
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 {
			continue
		}
		if n := ifc.Name; strings.HasPrefix(n, "docker") || strings.HasPrefix(n, "br-") || strings.HasPrefix(n, "veth") || strings.HasPrefix(n, "virbr") {
			continue
		}
		addrs, _ := ifc.Addrs()
		for _, a := range addrs {
			if ipn, ok := a.(*net.IPNet); ok && ipn.IP.To4() != nil {
				ips = append(ips, ipn.IP.String())
			}
		}
	}
	return ips
}

func mdnsHost() string {
	h, _ := os.Hostname()
	return h + ".local"
}

func pairLink(c *Config, secret, fingerprint string) string {
	q := url.Values{}
	q.Set("pair", secret)
	q.Set("fp", fingerprint)
	q.Set("port", strconv.Itoa(c.Port))
	q.Set("ip", strings.Join(lanIPs(), ","))
	q.Set("host", mdnsHost())
	q.Set("name", c.Name)
	return c.Server + "/#" + q.Encode()
}

// fingerprintHex : empreinte SHA-256 du certificat, en hexadécimal sans les « : »
func fingerprintHex() (string, error) {
	cert, err := certificate()
	if err != nil {
		return "", err
	}
	fps, err := cert.GetFingerprints()
	if err != nil {
		return "", err
	}
	for _, f := range fps {
		if f.Algorithm == "sha-256" {
			return strings.ToLower(strings.ReplaceAll(f.Value, ":", "")), nil
		}
	}
	return "", os.ErrNotExist
}
