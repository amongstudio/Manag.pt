package capture

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
)

const (
	maxHeaderBytes = 1 << 20
	maxBodyBytes   = 16 << 20
)

func writeMsg(w io.Writer, h Header, body []byte) error {
	raw, err := json.Marshal(h)
	if err != nil {
		return err
	}
	if len(raw) > maxHeaderBytes {
		return fmt.Errorf("capture pipe header too large")
	}
	if len(body) > maxBodyBytes {
		return fmt.Errorf("capture pipe body too large")
	}
	var hdr [8]byte
	binary.BigEndian.PutUint32(hdr[0:4], uint32(len(raw)))
	binary.BigEndian.PutUint32(hdr[4:8], uint32(len(body)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if _, err := w.Write(raw); err != nil {
		return err
	}
	if len(body) > 0 {
		_, err = w.Write(body)
	}
	return err
}

func readMsg(r io.Reader) (Header, []byte, error) {
	var hdr [8]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return Header{}, nil, err
	}
	hLen := binary.BigEndian.Uint32(hdr[0:4])
	bLen := binary.BigEndian.Uint32(hdr[4:8])
	if hLen > maxHeaderBytes || bLen > maxBodyBytes {
		return Header{}, nil, fmt.Errorf("capture pipe frame too large")
	}
	raw := make([]byte, hLen)
	if _, err := io.ReadFull(r, raw); err != nil {
		return Header{}, nil, err
	}
	var h Header
	if err := json.Unmarshal(raw, &h); err != nil {
		return Header{}, nil, err
	}
	var body []byte
	if bLen > 0 {
		body = make([]byte, bLen)
		if _, err := io.ReadFull(r, body); err != nil {
			return Header{}, nil, err
		}
	}
	return h, body, nil
}
