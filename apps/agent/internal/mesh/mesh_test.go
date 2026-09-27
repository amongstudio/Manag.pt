package mesh

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/pc-manager/agent/internal/peerfile"
)

func issueTestCA(t *testing.T) (*ecdsa.PrivateKey, *x509.Certificate, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "pc-manager-mesh-ca"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		IsCA:                  true,
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	cert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	return key, cert, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
}

func issueTestDevice(t *testing.T, caKey *ecdsa.PrivateKey, caCert *x509.Certificate, deviceID string) ([]byte, []byte) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	uri, err := url.Parse("urn:mnag:device:" + deviceID)
	if err != nil {
		t.Fatal(err)
	}
	serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 80))
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: deviceID},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		DNSNames:     []string{deviceID},
		URIs:         []*url.URL{uri},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, caCert, &key.PublicKey, caKey)
	if err != nil {
		t.Fatal(err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER})
	return certPEM, keyPEM
}

func storeIdent(t *testing.T, dir, deviceID string, certPEM, keyPEM, caPEM []byte) *Identity {
	t.Helper()
	if err := StoreBundle(dir, Bundle{Cert: string(certPEM), Key: string(keyPEM), CA: string(caPEM)}); err != nil {
		t.Fatal(err)
	}
	id, err := LoadIdentity(dir, deviceID)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func TestStoreLoadIdentityAndSAN(t *testing.T) {
	dir := t.TempDir()
	caKey, caCert, caPEM := issueTestCA(t)
	certPEM, keyPEM := issueTestDevice(t, caKey, caCert, "dev-a")
	id := storeIdent(t, dir, "dev-a", certPEM, keyPEM, caPEM)
	if id.DeviceID != "dev-a" {
		t.Fatalf("id=%s", id.DeviceID)
	}
	if id.Serial == "" || id.Expired(time.Now()) {
		t.Fatalf("serial/expiry %+v", id)
	}
}

func TestPolicyAndAuditPersist(t *testing.T) {
	dir := t.TempDir()
	p := Policy{Enabled: true, AllowCommands: []string{"get_files"}}
	if err := StorePolicy(dir, p); err != nil {
		t.Fatal(err)
	}
	got := LoadPolicy(dir)
	if !got.Enabled || len(got.AllowCommands) != 1 {
		t.Fatalf("%+v", got)
	}
	a := NewAudit(dir)
	a.Append(AuditEntry{Op: "file", PeerID: "p", Path: "/x", OK: true, Size: 3})
	entries := a.Drain()
	if len(entries) != 1 || entries[0]["source"] != "mesh" {
		t.Fatalf("%v", entries)
	}
	if len(a.Drain()) != 0 {
		t.Fatal("expected empty after drain")
	}
}

func TestCommandAllowlistDefaults(t *testing.T) {
	p := DefaultPolicy()
	if !CommandAllowed(p, "get_processes") || !CommandAllowed(p, "get_files") || !CommandAllowed(p, "get_adapters") {
		t.Fatal("defaults")
	}
	if !CommandAllowed(p, "get_event_log") || !CommandAllowed(p, "get_windows_update") || !CommandAllowed(p, "get_admin_center") {
		t.Fatal("native get_* defaults")
	}
	if !CommandAllowed(p, "get_tasks") || !CommandAllowed(p, "get_defender") || !CommandAllowed(p, "get_bitlocker") || !CommandAllowed(p, "get_capabilities") {
		t.Fatal("n2 get_* defaults")
	}
	if !CommandAllowed(p, "get_smb") {
		t.Fatal("get_smb default")
	}
	if CommandAllowed(p, "smb_connect") {
		t.Fatal("smb_connect is not a default")
	}
	if CommandAllowed(p, "set_task_enabled") {
		t.Fatal("set_task_enabled is not a default")
	}
	if CommandAllowed(p, "start_quick_assist") {
		t.Fatal("quick assist is not a default")
	}
	if CommandAllowed(p, "kill_switch") || CommandAllowed(p, "set_registry") || CommandAllowed(p, "run_plugin") {
		t.Fatal("dangerous defaults")
	}
	p.AllowCommands = []string{"kill_switch", "run_plugin"}
	if !CommandAllowed(p, "kill_switch") {
		t.Fatal("explicit kill_switch")
	}
	if CommandAllowed(p, "run_plugin") {
		t.Fatal("run_plugin never from peers")
	}
	p.AllowCommands = []string{"get_credentials", "restore_credentials", "smb_connect", "set_bitlocker"}
	if CommandAllowed(p, "get_credentials") || CommandAllowed(p, "restore_credentials") || CommandAllowed(p, "set_bitlocker") {
		t.Fatal("credential commands never from peers")
	}
	if !CommandAllowed(p, "smb_connect") {
		t.Fatal("passwordless smb_connect may be an extra")
	}
}

func TestAuditRestoreAfterFailedFlush(t *testing.T) {
	dir := t.TempDir()
	a := NewAudit(dir)
	a.Append(AuditEntry{Op: "cmd", PeerID: "p", CmdType: "get_processes", OK: true})
	entries := a.Drain()
	if len(entries) != 1 {
		t.Fatalf("%v", entries)
	}
	a.Restore(entries)
	again := a.Drain()
	if len(again) != 1 || again[0]["source"] != "mesh" {
		t.Fatalf("%v", again)
	}
}

func TestHasTURN(t *testing.T) {
	if hasTURN(nil) {
		t.Fatal("empty")
	}
	stun, _ := json.Marshal("stun:stun.example:3478")
	turn, _ := json.Marshal("turn:turn.example:3478")
	if hasTURN([]IceJSON{{URLs: stun}}) {
		t.Fatal("stun is not turn")
	}
	if !hasTURN([]IceJSON{{URLs: turn, Username: "u", Credential: "c"}}) {
		t.Fatal("turn required")
	}
}

func TestBeaconRoundTrip(t *testing.T) {
	raw := marshalBeacon("dev-1", 17891)
	id, port, err := unmarshalBeacon(raw)
	if err != nil || id != "dev-1" || port != 17891 {
		t.Fatalf("id=%s port=%d err=%v", id, port, err)
	}
	if _, _, err := unmarshalBeacon([]byte(`{"op":"cmd"}`)); err == nil {
		t.Fatal("unsigned JSON must not parse as beacon")
	}
}

func TestMTLSFileCopy(t *testing.T) {
	caKey, caCert, caPEM := issueTestCA(t)
	certA, keyA := issueTestDevice(t, caKey, caCert, "dev-a")
	certB, keyB := issueTestDevice(t, caKey, caCert, "dev-b")
	idA := storeIdent(t, t.TempDir(), "dev-a", certA, keyA, caPEM)
	idB := storeIdent(t, t.TempDir(), "dev-b", certB, keyB, caPEM)
	ln, err := tls.Listen("tcp", "127.0.0.1:0", idB.TLSConfig(true, "", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	src := filepath.Join(t.TempDir(), "note.txt")
	if err := os.WriteFile(src, []byte("hello-mesh"), 0o644); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(t.TempDir(), "note.txt")
	errCh := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			errCh <- err
			return
		}
		defer conn.Close()
		tlsConn := conn.(*tls.Conn)
		if err := tlsConn.Handshake(); err != nil {
			errCh <- err
			return
		}
		hdr, err := peerfile.ReadHeader(conn)
		if err != nil {
			errCh <- err
			return
		}
		if !peerfile.IsFileOp(hdr.Op) {
			errCh <- peerfile.ErrRefused
			return
		}
		_, err = peerfile.ReceiveFile(conn, dst, hdr.Size, 1<<20, nil)
		errCh <- err
	}()

	d := net.Dialer{Timeout: 2 * time.Second}
	raw, err := d.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		t.Fatal(err)
	}
	cli := tls.Client(raw, idA.TLSConfig(false, "dev-b", nil))
	defer cli.Close()
	if err := cli.Handshake(); err != nil {
		t.Fatal(err)
	}
	if _, err := peerfile.SendFile(cli, src, peerfile.MeshFileHeader("c1", "dev-a", "dev-b", src, dst, 0, 1<<20), nil); err != nil {
		t.Fatalf("send: %v", err)
	}
	if err := <-errCh; err != nil {
		t.Fatalf("recv: %v", err)
	}
	got, err := os.ReadFile(dst)
	if err != nil || string(got) != "hello-mesh" {
		t.Fatalf("got %q err=%v", got, err)
	}
}

func TestMTLSCmdRoundTrip(t *testing.T) {
	caKey, caCert, caPEM := issueTestCA(t)
	certA, keyA := issueTestDevice(t, caKey, caCert, "dev-a")
	certB, keyB := issueTestDevice(t, caKey, caCert, "dev-b")
	idA := storeIdent(t, t.TempDir(), "dev-a", certA, keyA, caPEM)
	idB := storeIdent(t, t.TempDir(), "dev-b", certB, keyB, caPEM)
	ln, err := tls.Listen("tcp", "127.0.0.1:0", idB.TLSConfig(true, "", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port
	errCh := make(chan error, 1)
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			errCh <- err
			return
		}
		defer conn.Close()
		if err := conn.(*tls.Conn).Handshake(); err != nil {
			errCh <- err
			return
		}
		hdr, err := peerfile.ReadPeer(conn)
		if err != nil {
			errCh <- err
			return
		}
		if !peerfile.IsCmdOp(hdr.Op) || hdr.CmdType != "get_processes" {
			errCh <- peerfile.ErrRefused
			return
		}
		if !CommandAllowed(DefaultPolicy(), hdr.CmdType) {
			errCh <- fmt.Errorf("not_allowed")
			return
		}
		errCh <- peerfile.WriteCmdResult(conn, hdr.ResultID, "success", map[string]any{"ok": true})
	}()
	d := net.Dialer{Timeout: 2 * time.Second}
	raw, err := d.Dial("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		t.Fatal(err)
	}
	cli := tls.Client(raw, idA.TLSConfig(false, "dev-b", nil))
	defer cli.Close()
	if err := cli.Handshake(); err != nil {
		t.Fatal(err)
	}
	res, err := exchangeCmd(cli, "dev-a", "dev-b", "get_processes", "rid-1", json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("cmd: %v", err)
	}
	if err := <-errCh; err != nil {
		t.Fatalf("server: %v", err)
	}
	if res.Status != "success" {
		t.Fatalf("%+v", res)
	}
}

func TestUnknownAndRevokedCertDropped(t *testing.T) {
	caKey, caCert, caPEM := issueTestCA(t)
	certA, keyA := issueTestDevice(t, caKey, caCert, "dev-a")
	idA := storeIdent(t, t.TempDir(), "dev-a", certA, keyA, caPEM)
	otherKey, otherCert, _ := issueTestCA(t)
	evilPEM, _ := issueTestDevice(t, otherKey, otherCert, "dev-evil")
	block, _ := pem.Decode(evilPEM)
	evilLeaf, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	if err := verifyPeer([][]byte{evilLeaf.Raw}, idA.Pool, nil, "dev-a"); err == nil {
		t.Fatal("unknown CA should drop")
	}
	goodBlock, _ := pem.Decode(certA)
	goodLeaf, err := x509.ParseCertificate(goodBlock.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	revoked := map[string]struct{}{NormSerial(SerialHex(goodLeaf)): {}}
	if err := verifyPeer([][]byte{goodLeaf.Raw}, idA.Pool, revoked, "dev-b"); err == nil {
		t.Fatal("revoked cert should drop")
	}
}

func TestForwardTargetStrip(t *testing.T) {
	if ForwardTarget(json.RawMessage(`{"meshForward":"dev-b"}`)) != "dev-b" {
		t.Fatal("forward")
	}
	got := StripForward(json.RawMessage(`{"meshForward":"dev-b","path":"."}`))
	var body map[string]any
	if json.Unmarshal(got, &body) != nil || body["meshForward"] != nil || body["path"] != "." {
		t.Fatalf("%s", got)
	}
}

func TestStripCommandSecretsDropsSmbPassword(t *testing.T) {
	got := StripCommandSecrets("smb_connect", json.RawMessage(`{"unc":"\\\\srv\\share","password":"hunter2","username":"u"}`))
	var body map[string]any
	if json.Unmarshal(got, &body) != nil {
		t.Fatalf("%s", got)
	}
	if body["password"] != nil || body["username"] != "u" {
		t.Fatalf("%v", body)
	}
	passthrough := StripCommandSecrets("get_smb", json.RawMessage(`{"password":"x"}`))
	var other map[string]any
	if json.Unmarshal(passthrough, &other) != nil || other["password"] != "x" {
		t.Fatalf("get_smb should not strip: %s", passthrough)
	}
	got = StripCommandSecrets("set_bitlocker", json.RawMessage(`{"action":"unlock","mountPoint":"D:","recoveryPassword":"111111-222222","password":"pw"}`))
	if json.Unmarshal(got, &body) != nil {
		t.Fatalf("%s", got)
	}
	if body["recoveryPassword"] != nil || body["password"] != nil || body["mountPoint"] != "D:" {
		t.Fatalf("set_bitlocker secrets: %v", body)
	}
}

func TestForbiddenBlobOps(t *testing.T) {
	if peerfile.ForbiddenOp("cmd") || peerfile.IsFileOp("cmd") || !peerfile.IsCmdOp("cmd") {
		t.Fatal("cmd is a mesh op")
	}
	if !peerfile.ForbiddenOp("plugin") || !peerfile.ForbiddenOp("run_plugin") || !peerfile.ForbiddenOp("blob") {
		t.Fatal("plugin blobs forbidden")
	}
	if peerfile.ForbiddenOp("file") || !peerfile.IsFileOp("offer") {
		t.Fatal("file ops")
	}
}
