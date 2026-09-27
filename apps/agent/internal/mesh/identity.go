package mesh

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/pc-manager/agent/internal/config"
	"github.com/pc-manager/agent/internal/peerfile"
)

const (
	certFile = "mesh.crt"
	keyFile  = "mesh.key"
	caFile   = "mesh-ca.crt"
	uriPref  = "urn:mnag:device:"
)

type Identity struct {
	Cert     tls.Certificate
	Leaf     *x509.Certificate
	Pool     *x509.CertPool
	CAPem    []byte
	DeviceID string
	Serial   string
	NotAfter time.Time
}

type Bundle struct {
	Cert           string   `json:"cert"`
	Key            string   `json:"key"`
	CA             string   `json:"ca"`
	Serial         string   `json:"serial"`
	NotAfter       string   `json:"notAfter"`
	RevokedSerials []string `json:"revokedSerials"`
}

func Paths(dataDir string) (crt, key, ca string) {
	return filepath.Join(dataDir, certFile), filepath.Join(dataDir, keyFile), filepath.Join(dataDir, caFile)
}

func StoreBundle(dataDir string, b Bundle) error {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return err
	}
	crt, key, ca := Paths(dataDir)
	if strings.TrimSpace(b.CA) != "" {
		if err := writeRestricted(ca, []byte(b.CA), 0o644); err != nil {
			return err
		}
	}
	if strings.TrimSpace(b.Cert) != "" && strings.TrimSpace(b.Key) != "" {
		if err := writeRestricted(crt, []byte(b.Cert), 0o644); err != nil {
			return err
		}
		if err := writeRestricted(key, []byte(b.Key), 0o600); err != nil {
			return err
		}
	}
	return nil
}

func writeRestricted(path string, raw []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, mode); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	config.RestrictFileACL(path)
	return nil
}

func LoadIdentity(dataDir, wantID string) (*Identity, error) {
	crtPath, keyPath, caPath := Paths(dataDir)
	certPEM, err := os.ReadFile(crtPath)
	if err != nil {
		return nil, err
	}
	keyPEM, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, err
	}
	caPEM, err := os.ReadFile(caPath)
	if err != nil {
		return nil, err
	}
	cert, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, err
	}
	if len(cert.Certificate) == 0 {
		return nil, fmt.Errorf("empty mesh cert")
	}
	leaf, err := x509.ParseCertificate(cert.Certificate[0])
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caPEM) {
		return nil, fmt.Errorf("invalid mesh CA")
	}
	id, err := DeviceIDFromCert(leaf)
	if err != nil {
		return nil, err
	}
	if wantID != "" && !strings.EqualFold(id, wantID) {
		return nil, fmt.Errorf("mesh cert device mismatch")
	}
	return &Identity{
		Cert:     cert,
		Leaf:     leaf,
		Pool:     pool,
		CAPem:    caPEM,
		DeviceID: id,
		Serial:   SerialHex(leaf),
		NotAfter: leaf.NotAfter,
	}, nil
}

func DeviceIDFromCert(c *x509.Certificate) (string, error) {
	if c == nil {
		return "", fmt.Errorf("no cert")
	}
	for _, u := range c.URIs {
		s := u.String()
		if strings.HasPrefix(s, uriPref) {
			id := strings.TrimPrefix(s, uriPref)
			if id != "" {
				return id, nil
			}
		}
	}
	for _, n := range c.DNSNames {
		n = strings.TrimSpace(n)
		if n != "" && n != "pc-manager-peer" {
			return n, nil
		}
	}
	cn := strings.TrimSpace(c.Subject.CommonName)
	if cn != "" && cn != "pc-manager-mesh-ca" {
		return cn, nil
	}
	return "", fmt.Errorf("no device SAN")
}

func SerialHex(c *x509.Certificate) string {
	if c == nil || c.SerialNumber == nil {
		return ""
	}
	return strings.ToLower(hex.EncodeToString(c.SerialNumber.Bytes()))
}

func NormSerial(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.TrimLeft(s, "0")
	if s == "" {
		return "0"
	}
	return s
}

func (id *Identity) Expired(now time.Time) bool {
	if id == nil || id.Leaf == nil {
		return true
	}
	return !now.Before(id.Leaf.NotAfter) || now.Before(id.Leaf.NotBefore)
}

func (id *Identity) TLSConfig(server bool, peerHint string, revoked map[string]struct{}) *tls.Config {
	cfg := &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{id.Cert},
		RootCAs:      id.Pool,
		NextProtos:   []string{peerfile.ALPN},
		VerifyPeerCertificate: func(raw [][]byte, _ [][]*x509.Certificate) error {
			return verifyPeer(raw, id.Pool, revoked, id.DeviceID)
		},
	}
	if server {
		cfg.ClientAuth = tls.RequireAndVerifyClientCert
		cfg.ClientCAs = id.Pool
	} else if peerHint != "" {
		cfg.ServerName = peerHint
	}
	return cfg
}

func verifyPeer(raw [][]byte, pool *x509.CertPool, revoked map[string]struct{}, selfID string) error {
	if len(raw) == 0 {
		return fmt.Errorf("missing peer cert")
	}
	cert, err := x509.ParseCertificate(raw[0])
	if err != nil {
		return err
	}
	opts := x509.VerifyOptions{Roots: pool, KeyUsages: []x509.ExtKeyUsage{x509.ExtKeyUsageAny}}
	if _, err := cert.Verify(opts); err != nil {
		return fmt.Errorf("unknown mesh cert")
	}
	if _, ok := revoked[NormSerial(SerialHex(cert))]; ok {
		return fmt.Errorf("revoked mesh cert")
	}
	peerID, err := DeviceIDFromCert(cert)
	if err != nil || peerID == "" {
		return fmt.Errorf("unknown mesh cert")
	}
	if selfID != "" && strings.EqualFold(peerID, selfID) {
		return fmt.Errorf("self mesh cert")
	}
	return nil
}
