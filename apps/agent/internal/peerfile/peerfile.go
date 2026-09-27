package peerfile

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/pc-manager/agent/internal/client"
)

const (
	dialTimeout   = 3 * time.Second
	listenTimeout = 20 * time.Second
)

var ErrDial = errors.New("lan_dial_failed")

type Result struct {
	Via    string `json:"via"`
	SHA256 string `json:"sha256,omitempty"`
	Size   int64  `json:"size,omitempty"`
	FileID string `json:"fileId,omitempty"`
}

type Payload struct {
	Ticket       Ticket   `json:"ticket"`
	FileID       string   `json:"fileId,omitempty"`
	Mesh         bool     `json:"mesh,omitempty"`
	CopyID       string   `json:"copyId,omitempty"`
	DestDeviceID string   `json:"destDeviceId,omitempty"`
	SrcPath      string   `json:"srcPath,omitempty"`
	DestPath     string   `json:"destPath,omitempty"`
	Addrs        []string `json:"addrs,omitempty"`
	Port         int      `json:"port,omitempty"`
}

func ParsePayload(raw json.RawMessage) (Payload, error) {
	var p Payload
	if err := json.Unmarshal(raw, &p); err != nil {
		return Payload{}, err
	}
	if p.Mesh {
		if strings.TrimSpace(p.DestPath) == "" {
			return Payload{}, fmt.Errorf("invalid mesh payload")
		}
		if p.CopyID == "" {
			p.CopyID = p.Ticket.CopyID
		}
		if p.Port <= 0 {
			p.Port = p.Ticket.Port
		}
		return p, nil
	}
	if p.Ticket.CopyID == "" || p.Ticket.Sig == "" {
		return Payload{}, fmt.Errorf("invalid ticket")
	}
	return p, nil
}

func Listen(deviceID, destPath string, expected Ticket, progress func(int)) (Result, error) {
	if expected.DstDeviceID != "" && deviceID != expected.DstDeviceID {
		return Result{}, fmt.Errorf("ticket device mismatch")
	}
	if expected.Expired(time.Now()) {
		return Result{}, fmt.Errorf("ticket expired")
	}
	if destPath == "" {
		destPath = expected.DestPath
	}
	cert, err := ephemeralCert()
	if err != nil {
		return Result{}, err
	}
	tcp, err := net.Listen("tcp", net.JoinHostPort("", strconv.Itoa(expected.Port)))
	if err != nil {
		return Result{}, err
	}
	if tl, ok := tcp.(*net.TCPListener); ok {
		_ = tl.SetDeadline(time.Now().Add(listenTimeout))
	}
	tlsLn := tls.NewListener(tcp, &tls.Config{
		MinVersion:   tls.VersionTLS12,
		Certificates: []tls.Certificate{cert},
		NextProtos:   []string{ALPN},
	})
	defer tlsLn.Close()

	conn, err := tlsLn.Accept()
	if err != nil {
		if ne, ok := err.(net.Error); ok && ne.Timeout() {
			return Result{Via: "listen_timeout"}, nil
		}
		return Result{Via: "listen_timeout"}, nil
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))

	hdr, err := readFrame(conn)
	if err != nil {
		return Result{}, fmt.Errorf("peer_refused")
	}
	if hdr.Op != "offer" {
		return Result{}, fmt.Errorf("peer_refused")
	}
	got := hdr.ticket()
	if !ticketsEqual(got, expected) {
		return Result{}, fmt.Errorf("peer_refused")
	}
	if hdr.Size <= 0 || hdr.Size > expected.MaxBytes || hdr.Size > client.MaxUploadBytes() {
		return Result{}, fmt.Errorf("too_large")
	}

	dest := destPath
	if st, err := os.Stat(dest); err == nil && st.IsDir() {
		dest = filepath.Join(dest, filepath.Base(expected.SrcPath))
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return Result{}, err
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return Result{}, err
	}
	defer f.Close()

	hash := sha256.New()
	wrote, err := copyProgress(io.MultiWriter(f, hash), io.LimitReader(conn, hdr.Size), hdr.Size, progress)
	if err != nil {
		_ = os.Remove(dest)
		return Result{}, err
	}
	if wrote != hdr.Size {
		_ = os.Remove(dest)
		return Result{}, fmt.Errorf("short file")
	}
	var want [sha256.Size]byte
	if _, err := io.ReadFull(conn, want[:]); err != nil {
		_ = os.Remove(dest)
		return Result{}, err
	}
	var gotHash [sha256.Size]byte
	copy(gotHash[:], hash.Sum(nil))
	if want != gotHash {
		_ = os.Remove(dest)
		return Result{}, fmt.Errorf("hash mismatch")
	}
	_ = conn.SetDeadline(time.Now().Add(15 * time.Second))
	if err := writeFrame(conn, header{Op: "complete", SHA256: hashHex(gotHash), Size: wrote}); err != nil {
		return Result{}, err
	}
	if progress != nil {
		progress(100)
	}
	return Result{Via: "lan", SHA256: hashHex(gotHash), Size: wrote}, nil
}

func Offer(deviceID, srcPath string, ticket Ticket, progress func(int)) (Result, error) {
	if ticket.SrcDeviceID != "" && deviceID != ticket.SrcDeviceID {
		return Result{}, fmt.Errorf("ticket device mismatch")
	}
	if ticket.Expired(time.Now()) {
		return Result{}, fmt.Errorf("ticket expired")
	}
	st, err := os.Stat(srcPath)
	if err != nil {
		return Result{}, err
	}
	if st.IsDir() {
		return Result{}, fmt.Errorf("not a file")
	}
	if st.Size() > ticket.MaxBytes || st.Size() > client.MaxUploadBytes() {
		return Result{}, fmt.Errorf("too_large")
	}
	res, err := dialCopy(srcPath, st.Size(), ticket, progress)
	if err != nil {
		return Result{}, err
	}
	return res, nil
}

func dialCopy(srcPath string, size int64, ticket Ticket, progress func(int)) (Result, error) {
	if len(ticket.Addrs) == 0 {
		return Result{}, ErrDial
	}
	deadline := time.Now().Add(dialTimeout)
	var last error
	for _, addr := range ticket.Addrs {
		if time.Now().After(deadline) {
			break
		}
		res, err := dialOne(addr, srcPath, size, ticket, deadline, progress)
		if err == nil {
			return res, nil
		}
		last = err
	}
	if last == nil {
		last = ErrDial
	}
	return Result{}, ErrDial
}

func dialOne(addr, srcPath string, size int64, ticket Ticket, deadline time.Time, progress func(int)) (Result, error) {
	remain := time.Until(deadline)
	if remain <= 0 {
		return Result{}, ErrDial
	}
	d := net.Dialer{Timeout: remain}
	raw, err := d.Dial("tcp", net.JoinHostPort(addr, strconv.Itoa(ticket.Port)))
	if err != nil {
		return Result{}, err
	}
	conn := tls.Client(raw, &tls.Config{
		InsecureSkipVerify: true,
		MinVersion:         tls.VersionTLS12,
		NextProtos:         []string{ALPN},
		ServerName:         "pc-manager-peer",
	})
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
	if err := conn.Handshake(); err != nil {
		return Result{}, err
	}
	if err := writeFrame(conn, offerHeader(ticket, size)); err != nil {
		return Result{}, err
	}
	f, err := os.Open(srcPath)
	if err != nil {
		return Result{}, err
	}
	defer f.Close()
	hash := sha256.New()
	wrote, err := copyProgress(io.MultiWriter(conn, hash), f, size, progress)
	if err != nil {
		return Result{}, err
	}
	if wrote != size {
		return Result{}, fmt.Errorf("short file")
	}
	var sum [sha256.Size]byte
	copy(sum[:], hash.Sum(nil))
	if _, err := conn.Write(sum[:]); err != nil {
		return Result{}, err
	}
	ack, err := readFrame(conn)
	if err != nil {
		return Result{}, err
	}
	if ack.Op == "error" {
		return Result{}, fmt.Errorf("%s", ack.Message)
	}
	if ack.Op != "complete" {
		return Result{}, fmt.Errorf("peer_refused")
	}
	if ack.SHA256 != "" && ack.SHA256 != hashHex(sum) {
		return Result{}, fmt.Errorf("hash mismatch")
	}
	if progress != nil {
		progress(100)
	}
	return Result{Via: "lan", SHA256: hashHex(sum), Size: size}, nil
}

func copyProgress(dst io.Writer, src io.Reader, total int64, progress func(int)) (int64, error) {
	buf := make([]byte, 256<<10)
	var wrote int64
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return wrote, werr
			}
			wrote += int64(n)
			if progress != nil && total > 0 {
				progress(int(wrote * 100 / total))
			}
		}
		if errors.Is(err, io.EOF) {
			return wrote, nil
		}
		if err != nil {
			return wrote, err
		}
	}
}

func ephemeralCert() (tls.Certificate, error) {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "pc-manager-peer"},
		NotBefore:             time.Now().Add(-time.Minute),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"pc-manager-peer"},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}

func FileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, io.LimitReader(f, client.MaxUploadBytes()+1)); err != nil {
		return "", err
	}
	var sum [sha256.Size]byte
	copy(sum[:], h.Sum(nil))
	return hashHex(sum), nil
}
