package peerfile

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

const (
	magic      = "PMPEER1"
	maxHeader  = 256 << 10
	ALPN       = "pm-peer-file"
	maxMessage = 200
)

type header struct {
	Op          string          `json:"op"`
	CopyID      string          `json:"copyId,omitempty"`
	SrcDeviceID string          `json:"srcDeviceId,omitempty"`
	DstDeviceID string          `json:"dstDeviceId,omitempty"`
	SrcPath     string          `json:"srcPath,omitempty"`
	DestPath    string          `json:"destPath,omitempty"`
	Exp         int64           `json:"exp,omitempty"`
	MaxBytes    int64           `json:"maxBytes,omitempty"`
	Port        int             `json:"port,omitempty"`
	Addrs       []string        `json:"addrs,omitempty"`
	Sig         string          `json:"sig,omitempty"`
	Size        int64           `json:"size,omitempty"`
	SHA256      string          `json:"sha256,omitempty"`
	Message     string          `json:"message,omitempty"`
	CmdType     string          `json:"cmdType,omitempty"`
	Payload     json.RawMessage `json:"payload,omitempty"`
	ResultID    string          `json:"resultId,omitempty"`
	Status      string          `json:"status,omitempty"`
	Result      json.RawMessage `json:"result,omitempty"`
}

func (h header) ticket() Ticket {
	return Ticket{
		CopyID:      h.CopyID,
		SrcDeviceID: h.SrcDeviceID,
		DstDeviceID: h.DstDeviceID,
		SrcPath:     h.SrcPath,
		DestPath:    h.DestPath,
		Exp:         h.Exp,
		MaxBytes:    h.MaxBytes,
		Port:        h.Port,
		Addrs:       h.Addrs,
		Sig:         h.Sig,
	}
}

func offerHeader(t Ticket, size int64) header {
	return header{
		Op:          "offer",
		CopyID:      t.CopyID,
		SrcDeviceID: t.SrcDeviceID,
		DstDeviceID: t.DstDeviceID,
		SrcPath:     t.SrcPath,
		DestPath:    t.DestPath,
		Exp:         t.Exp,
		MaxBytes:    t.MaxBytes,
		Port:        t.Port,
		Addrs:       t.Addrs,
		Sig:         t.Sig,
		Size:        size,
	}
}

func writeFrame(w io.Writer, h header) error {
	raw, err := json.Marshal(h)
	if err != nil {
		return err
	}
	if len(raw) > maxHeader {
		return fmt.Errorf("peer header too large")
	}
	var prefix [7 + 4]byte
	copy(prefix[:7], magic)
	binary.BigEndian.PutUint32(prefix[7:], uint32(len(raw)))
	if _, err := w.Write(prefix[:]); err != nil {
		return err
	}
	_, err = w.Write(raw)
	return err
}

func readFrame(r io.Reader) (header, error) {
	var prefix [7 + 4]byte
	if _, err := io.ReadFull(r, prefix[:]); err != nil {
		return header{}, err
	}
	if string(prefix[:7]) != magic {
		return header{}, fmt.Errorf("peer_refused")
	}
	n := binary.BigEndian.Uint32(prefix[7:])
	if n == 0 || n > maxHeader {
		return header{}, fmt.Errorf("peer_refused")
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return header{}, err
	}
	var h header
	if err := json.Unmarshal(buf, &h); err != nil {
		return header{}, fmt.Errorf("peer_refused")
	}
	h.Op = strings.ToLower(strings.TrimSpace(h.Op))
	if len(h.Message) > maxMessage {
		h.Message = h.Message[:maxMessage]
	}
	return h, nil
}

func hashHex(sum [sha256.Size]byte) string {
	return hex.EncodeToString(sum[:])
}

func parseHash(s string) ([sha256.Size]byte, error) {
	var out [sha256.Size]byte
	b, err := hex.DecodeString(strings.TrimSpace(s))
	if err != nil || len(b) != sha256.Size {
		return out, fmt.Errorf("bad hash")
	}
	copy(out[:], b)
	return out, nil
}
