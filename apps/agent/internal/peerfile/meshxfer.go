package peerfile

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"

	"github.com/pc-manager/agent/internal/client"
)

var ErrRefused = fmt.Errorf("peer_refused")

type FileHead struct {
	Op          string
	CopyID      string
	SrcDeviceID string
	DstDeviceID string
	SrcPath     string
	DestPath    string
	Size        int64
	MaxBytes    int64
}

func (h header) fileHead() FileHead {
	return FileHead{
		Op:          h.Op,
		CopyID:      h.CopyID,
		SrcDeviceID: h.SrcDeviceID,
		DstDeviceID: h.DstDeviceID,
		SrcPath:     h.SrcPath,
		DestPath:    h.DestPath,
		Size:        h.Size,
		MaxBytes:    h.MaxBytes,
	}
}

func (h FileHead) frame() header {
	return header{
		Op:          h.Op,
		CopyID:      h.CopyID,
		SrcDeviceID: h.SrcDeviceID,
		DstDeviceID: h.DstDeviceID,
		SrcPath:     h.SrcPath,
		DestPath:    h.DestPath,
		Size:        h.Size,
		MaxBytes:    h.MaxBytes,
	}
}

func IsFileOp(op string) bool {
	switch strings.ToLower(strings.TrimSpace(op)) {
	case "file", "offer":
		return true
	default:
		return false
	}
}

func IsCmdOp(op string) bool {
	return strings.ToLower(strings.TrimSpace(op)) == "cmd"
}

func ForbiddenOp(op string) bool {
	switch strings.ToLower(strings.TrimSpace(op)) {
	case "command", "plugin", "run_plugin", "blob":
		return true
	default:
		return false
	}
}

type PeerHead struct {
	FileHead
	CmdType  string
	Payload  json.RawMessage
	ResultID string
	Status   string
	Result   json.RawMessage
	Message  string
}

func (h header) peerHead() PeerHead {
	return PeerHead{
		FileHead: h.fileHead(),
		CmdType:  h.CmdType,
		Payload:  h.Payload,
		ResultID: h.ResultID,
		Status:   h.Status,
		Result:   h.Result,
		Message:  h.Message,
	}
}

func MeshFileHeader(copyID, srcID, dstID, srcPath, destPath string, size, maxBytes int64) FileHead {
	return FileHead{
		Op:          "file",
		CopyID:      copyID,
		SrcDeviceID: srcID,
		DstDeviceID: dstID,
		SrcPath:     srcPath,
		DestPath:    destPath,
		Size:        size,
		MaxBytes:    maxBytes,
	}
}

func ReadHeader(r io.Reader) (FileHead, error) {
	h, err := readFrame(r)
	if err != nil {
		return FileHead{}, err
	}
	return h.fileHead(), nil
}

func ReadPeer(r io.Reader) (PeerHead, error) {
	h, err := readFrame(r)
	if err != nil {
		return PeerHead{}, err
	}
	return h.peerHead(), nil
}

func MeshCmdHeader(copyID, srcID, dstID, cmdType, resultID string, payload json.RawMessage) header {
	if len(payload) == 0 {
		payload = json.RawMessage(`{}`)
	}
	return header{
		Op:          "cmd",
		CopyID:      copyID,
		SrcDeviceID: srcID,
		DstDeviceID: dstID,
		CmdType:     cmdType,
		ResultID:    resultID,
		Payload:     payload,
	}
}

func WriteMeshCmd(w io.Writer, copyID, srcID, dstID, cmdType, resultID string, payload json.RawMessage) error {
	return writeFrame(w, MeshCmdHeader(copyID, srcID, dstID, cmdType, resultID, payload))
}

func WriteCmdResult(w io.Writer, resultID, status string, result any) error {
	raw, err := json.Marshal(result)
	if err != nil {
		raw = []byte(`{"error":"result_unserializable"}`)
	}
	if status == "" {
		status = "success"
	}
	return writeFrame(w, header{Op: "result", ResultID: resultID, Status: status, Result: raw})
}

func ReadCmdResult(r io.Reader) (PeerHead, error) {
	h, err := ReadPeer(r)
	if err != nil {
		return PeerHead{}, err
	}
	if h.Op == "error" {
		msg := h.Message
		if msg == "" {
			msg = "peer_refused"
		}
		return h, fmt.Errorf("%s", msg)
	}
	if h.Op != "result" {
		return h, ErrRefused
	}
	return h, nil
}

func WriteError(w io.Writer, msg string) error {
	return writeFrame(w, header{Op: "error", Message: msg})
}

func ReceiveFile(conn net.Conn, destPath string, size, maxBytes int64, progress func(int)) (Result, error) {
	capBytes := maxBytes
	if capBytes <= 0 || capBytes > client.MaxUploadBytes() {
		capBytes = client.MaxUploadBytes()
	}
	if size <= 0 || size > capBytes {
		return Result{}, fmt.Errorf("too_large")
	}
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return Result{}, err
	}
	if st, err := os.Stat(destPath); err == nil && st.IsDir() {
		return Result{}, fmt.Errorf("dest is a directory")
	}
	f, err := os.OpenFile(destPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return Result{}, err
	}
	defer f.Close()
	hash := sha256.New()
	wrote, err := copyProgress(io.MultiWriter(f, hash), io.LimitReader(conn, size), size, progress)
	if err != nil {
		_ = os.Remove(destPath)
		return Result{}, err
	}
	if wrote != size {
		_ = os.Remove(destPath)
		return Result{}, fmt.Errorf("short file")
	}
	var want [sha256.Size]byte
	if _, err := io.ReadFull(conn, want[:]); err != nil {
		_ = os.Remove(destPath)
		return Result{}, err
	}
	var gotHash [sha256.Size]byte
	copy(gotHash[:], hash.Sum(nil))
	if want != gotHash {
		_ = os.Remove(destPath)
		return Result{}, fmt.Errorf("hash mismatch")
	}
	if err := writeFrame(conn, header{Op: "complete", SHA256: hashHex(gotHash), Size: wrote}); err != nil {
		return Result{}, err
	}
	if progress != nil {
		progress(100)
	}
	return Result{Via: "lan", SHA256: hashHex(gotHash), Size: wrote}, nil
}

func SendFile(conn net.Conn, srcPath string, hdr FileHead, progress func(int)) (Result, error) {
	st, err := os.Stat(srcPath)
	if err != nil {
		return Result{}, err
	}
	if st.IsDir() {
		return Result{}, fmt.Errorf("not a file")
	}
	hdr.Size = st.Size()
	if err := writeFrame(conn, hdr.frame()); err != nil {
		return Result{}, err
	}
	f, err := os.Open(srcPath)
	if err != nil {
		return Result{}, err
	}
	defer f.Close()
	hash := sha256.New()
	wrote, err := copyProgress(io.MultiWriter(conn, hash), f, st.Size(), progress)
	if err != nil {
		return Result{}, err
	}
	if wrote != st.Size() {
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
		return Result{}, ErrRefused
	}
	if ack.SHA256 != "" && ack.SHA256 != hashHex(sum) {
		return Result{}, fmt.Errorf("hash mismatch")
	}
	if progress != nil {
		progress(100)
	}
	return Result{Via: "lan", SHA256: hashHex(sum), Size: st.Size()}, nil
}
