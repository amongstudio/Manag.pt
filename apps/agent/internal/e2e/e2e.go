package e2e

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/crypto/curve25519"
	"golang.org/x/crypto/hkdf"

	"github.com/pc-manager/agent/internal/wsprotocol"
)

const (
	keyFileName = "e2e-x25519.key"
	pubFileName = "e2e-x25519.pub"
)

type Box struct {
	priv [32]byte
	pub  [32]byte

	mu        sync.Mutex
	sessionID string
	gcm       cipher.AEAD
}

type DataEnvelope struct {
	Action      string `json:"action"`
	SessionID   string `json:"sessionId"`
	Kind        string `json:"kind,omitempty"`
	Nonce       string `json:"nonce,omitempty"`
	Ciphertext  string `json:"ciphertext,omitempty"`
	AAD         string `json:"aad,omitempty"`
	OperatorPub string `json:"operatorPub,omitempty"`
	AgentPub    string `json:"agentPub,omitempty"`
}

func LoadOrCreate(dataDir string) (*Box, error) {
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return nil, err
	}
	keyPath := filepath.Join(dataDir, keyFileName)
	raw, err := os.ReadFile(keyPath)
	var priv [32]byte
	switch {
	case err == nil && len(raw) == 32:
		copy(priv[:], raw)
	case err == nil:
		return nil, fmt.Errorf("e2e key %s has invalid length %d", keyPath, len(raw))
	case os.IsNotExist(err):
		if _, err := rand.Read(priv[:]); err != nil {
			return nil, err
		}
		if err := os.WriteFile(keyPath, priv[:], 0o600); err != nil {
			return nil, err
		}
	default:
		return nil, err
	}
	pub, err := curve25519.X25519(priv[:], curve25519.Basepoint)
	if err != nil {
		return nil, err
	}
	var pubArr [32]byte
	copy(pubArr[:], pub)
	_ = os.WriteFile(filepath.Join(dataDir, pubFileName), []byte(hex.EncodeToString(pubArr[:])), 0o644)
	return &Box{priv: priv, pub: pubArr}, nil
}

func (b *Box) PubHex() string {
	return hex.EncodeToString(b.pub[:])
}

func (b *Box) Active() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.gcm != nil && b.sessionID != ""
}

func (b *Box) SessionID() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.sessionID
}

func (b *Box) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.gcm = nil
	b.sessionID = ""
}

func (b *Box) AcceptOffer(sessionID, operatorPubHex string) error {
	remote, err := parsePub(operatorPubHex)
	if err != nil {
		return err
	}
	shared, err := curve25519.X25519(b.priv[:], remote[:])
	if err != nil {
		return err
	}
	gcm, err := gcmFromShared(shared)
	if err != nil {
		return err
	}
	b.mu.Lock()
	b.sessionID = sessionID
	b.gcm = gcm
	b.mu.Unlock()
	return nil
}

func (b *Box) Seal(kind string, plaintext []byte, aad string) (DataEnvelope, error) {
	b.mu.Lock()
	gcm := b.gcm
	sessionID := b.sessionID
	b.mu.Unlock()
	if gcm == nil || sessionID == "" {
		return DataEnvelope{}, errors.New("no e2e session")
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return DataEnvelope{}, err
	}
	ct := gcm.Seal(nil, nonce, plaintext, []byte(aad))
	return DataEnvelope{
		Action:     "data",
		SessionID:  sessionID,
		Kind:       kind,
		Nonce:      base64.StdEncoding.EncodeToString(nonce),
		Ciphertext: base64.StdEncoding.EncodeToString(ct),
		AAD:        aad,
	}, nil
}

func (b *Box) Open(nonceB64, ciphertextB64, aad string) ([]byte, error) {
	ct, err := base64.StdEncoding.DecodeString(ciphertextB64)
	if err != nil {
		return nil, err
	}
	return b.OpenRaw(nonceB64, ct, aad)
}

func (b *Box) OpenRaw(nonceB64 string, ciphertext []byte, aad string) ([]byte, error) {
	b.mu.Lock()
	gcm := b.gcm
	b.mu.Unlock()
	if gcm == nil {
		return nil, errors.New("no e2e session")
	}
	nonce, err := base64.StdEncoding.DecodeString(nonceB64)
	if err != nil {
		return nil, err
	}
	return gcm.Open(nil, nonce, ciphertext, []byte(aad))
}

func EncodeChunkPlain(header wsprotocol.FileChunk, payload []byte) ([]byte, error) {
	raw, err := json.Marshal(header)
	if err != nil {
		return nil, err
	}
	out := make([]byte, 4+len(raw)+len(payload))
	binary.BigEndian.PutUint32(out[:4], uint32(len(raw)))
	copy(out[4:], raw)
	copy(out[4+len(raw):], payload)
	return out, nil
}

func DecodeChunkPlain(plain []byte) (wsprotocol.FileChunk, []byte, error) {
	var header wsprotocol.FileChunk
	if len(plain) < 4 {
		return header, nil, fmt.Errorf("chunk plaintext too short")
	}
	headerLen := binary.BigEndian.Uint32(plain[:4])
	if uint64(headerLen) > uint64(len(plain)-4) {
		return header, nil, fmt.Errorf("chunk header truncated")
	}
	n := int(headerLen)
	if err := json.Unmarshal(plain[4:4+n], &header); err != nil {
		return header, nil, err
	}
	return header, plain[4+n:], nil
}

func parsePub(hexKey string) ([32]byte, error) {
	var out [32]byte
	raw, err := hex.DecodeString(hexKey)
	if err != nil || len(raw) != 32 {
		return out, fmt.Errorf("invalid public key")
	}
	copy(out[:], raw)
	return out, nil
}

func gcmFromShared(shared []byte) (cipher.AEAD, error) {
	salt := make([]byte, wsprotocol.E2ESaltLen)
	h := hkdf.New(sha256.New, shared, salt, []byte(wsprotocol.E2EInfo))
	key := make([]byte, 32)
	if _, err := io.ReadFull(h, key); err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
