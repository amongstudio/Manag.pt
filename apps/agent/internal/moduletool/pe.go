package moduletool

import (
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
)

func inspectPE(path string) (kind, arch string, err error) {
	f, err := os.Open(path)
	if err != nil {
		return "", "", err
	}
	defer f.Close()
	header := make([]byte, 65_536)
	n, readErr := io.ReadFull(f, header)
	if readErr != nil && !errors.Is(readErr, io.ErrUnexpectedEOF) {
		return "", "", readErr
	}
	header = header[:n]
	if len(header) < 64 || header[0] != 'M' || header[1] != 'Z' {
		return "", "", errors.New("invalid PE DOS header")
	}
	peOffset := int(binary.LittleEndian.Uint32(header[0x3c:0x40]))
	if peOffset < 64 || peOffset+24 > len(header) {
		return "", "", errors.New("invalid PE offset")
	}
	if string(header[peOffset:peOffset+4]) != "PE\x00\x00" {
		return "", "", errors.New("invalid PE signature")
	}
	switch binary.LittleEndian.Uint16(header[peOffset+4 : peOffset+6]) {
	case 0x8664:
		arch = "amd64"
	case 0xaa64:
		arch = "arm64"
	default:
		return "", "", fmt.Errorf("unsupported PE architecture")
	}
	if binary.LittleEndian.Uint16(header[peOffset+6:peOffset+8]) < 1 {
		return "", "", errors.New("PE has no sections")
	}
	optionalHeaderSize := int(binary.LittleEndian.Uint16(header[peOffset+20 : peOffset+22]))
	if optionalHeaderSize < 2 || peOffset+24+optionalHeaderSize > len(header) {
		return "", "", errors.New("invalid PE optional header")
	}
	if binary.LittleEndian.Uint16(header[peOffset+24:peOffset+26]) != 0x20b {
		return "", "", errors.New("unsupported PE format")
	}
	characteristics := binary.LittleEndian.Uint16(header[peOffset+22 : peOffset+24])
	if characteristics&0x0002 == 0 {
		return "", "", errors.New("PE is not executable")
	}
	kind = "exe"
	if characteristics&0x2000 != 0 {
		kind = "dll-plugin"
	}
	return kind, arch, nil
}
