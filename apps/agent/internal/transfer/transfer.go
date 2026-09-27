package transfer

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/klauspost/compress/zstd"

	"github.com/pc-manager/agent/internal/client"
	"github.com/pc-manager/agent/internal/e2e"
	"github.com/pc-manager/agent/internal/wsprotocol"
)

type WS interface {
	Connected() bool
	CapsZstd() bool
	SendJSON(v any) error
	SendFileChunk(header wsprotocol.FileChunk, payload []byte) error
	SendE2EEnvelope(payload any) error
}

type Engine struct {
	HTTP *client.Client
	WS   WS
	E2E  *e2e.Box

	mu      sync.Mutex
	waiters map[string]*waiter
}

type waiter struct {
	ch     chan chunkEvent
	closed chan struct{}
}

type chunkEvent struct {
	Header  wsprotocol.FileChunk
	Payload []byte
}

func New(httpClient *client.Client, ws WS, box *e2e.Box) *Engine {
	return &Engine{HTTP: httpClient, WS: ws, E2E: box, waiters: make(map[string]*waiter)}
}

func (e *Engine) Handle(header wsprotocol.FileChunk, payload []byte) {
	id := header.TransferID
	if id == "" {
		id = header.FileID
	}
	e.mu.Lock()
	w := e.waiters[id]
	e.mu.Unlock()
	if w == nil {
		return
	}
	ev := chunkEvent{Header: header, Payload: append([]byte(nil), payload...)}
	select {
	case w.ch <- ev:
	case <-w.closed:
	default:
		go func() {
			select {
			case w.ch <- ev:
			case <-w.closed:
			}
		}()
	}
}

func (e *Engine) Upload(localPath, remotePath string, progress func(int)) error {
	_, err := e.upload(localPath, remotePath, progress, false)
	return err
}

func (e *Engine) UploadID(localPath, remotePath string, progress func(int)) (string, error) {
	return e.upload(localPath, remotePath, progress, true)
}

func (e *Engine) upload(localPath, remotePath string, progress func(int), skipE2E bool) (string, error) {
	st, err := os.Stat(localPath)
	if err != nil {
		return "", err
	}
	if st.IsDir() {
		return "", fmt.Errorf("not a file")
	}
	if st.Size() > client.MaxUploadBytes() {
		return "", fmt.Errorf("too_large")
	}
	if !skipE2E && e.E2E != nil && e.E2E.Active() && e.WS != nil && e.WS.Connected() {
		return "", e.uploadE2E(localPath, remotePath, st.Size(), progress)
	}
	useWS := e.WS != nil && e.WS.Connected() && st.Size() > wsprotocol.HTTPFallback
	if !useWS {
		if progress != nil {
			progress(0)
		}
		id, err := e.HTTP.UploadFileID(localPath, remotePath)
		if err != nil {
			return "", err
		}
		if progress != nil {
			progress(100)
		}
		return id, nil
	}
	info, err := e.HTTP.InitUpload(remotePath, st.Size())
	if err != nil {
		return "", err
	}
	if err := e.uploadWS(localPath, remotePath, info, st.Size(), progress); err != nil {
		return "", err
	}
	return info.ID, nil
}

func (e *Engine) uploadWS(localPath, remotePath string, info *client.TransferInfo, size int64, progress func(int)) error {
	f, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer f.Close()
	offset := info.Offset
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	ch := e.arm(info.ID)
	defer e.disarm(info.ID)
	buf := make([]byte, wsprotocol.ChunkSize)
	for offset < size {
		n, err := f.Read(buf)
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		if n == 0 {
			break
		}
		payload := buf[:n]
		codec := "none"
		if size >= wsprotocol.ZstdMin && e.WS.CapsZstd() {
			if compressed, ok := compress(payload); ok {
				payload = compressed
				codec = "zstd"
			}
		}
		header := wsprotocol.FileChunk{
			Type:       wsprotocol.TypeFileChunk,
			TransferID: info.ID,
			Offset:     offset,
			Length:     int64(n),
			TotalSize:  size,
			Final:      offset+int64(n) >= size,
			Codec:      codec,
			Direction:  "upload",
			Action:     "data",
			RemotePath: remotePath,
		}
		if err := e.WS.SendFileChunk(header, payload); err != nil {
			return err
		}
		ev, err := e.wait(ch, 45*time.Second)
		if err != nil {
			return err
		}
		if ev.Header.Action == "error" {
			return fmt.Errorf("upload chunk: %s", ev.Header.Message)
		}
		offset += int64(n)
		if progress != nil && size > 0 {
			progress(int(offset * 100 / size))
		}
	}
	if progress != nil {
		progress(100)
	}
	return nil
}

func (e *Engine) Download(fileID, dest string, progress func(int)) error {
	info, err := e.HTTP.TransferMeta(fileID)
	size := int64(0)
	offset := int64(0)
	if err == nil {
		size = info.Size
		offset = info.Offset
	}
	if st, statErr := os.Stat(dest); statErr == nil && !st.IsDir() {
		if st.Size() > offset {
			offset = st.Size()
		}
	}
	useWS := e.WS != nil && e.WS.Connected() && (size > wsprotocol.HTTPFallback || size == 0)
	if !useWS || size > 0 && size <= wsprotocol.HTTPFallback {
		if progress != nil {
			progress(0)
		}
		return e.HTTP.DownloadFile(fileID, dest, offset)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	ch := e.arm(fileID)
	defer e.disarm(fileID)
	if size > client.MaxUploadBytes() {
		return fmt.Errorf("too_large")
	}
	maxChunks := int(client.MaxUploadBytes()/int64(wsprotocol.ChunkSize)) + 8
	for i := 0; i < maxChunks; i++ {
		req := wsprotocol.FileChunk{
			Type:       wsprotocol.TypeFileChunk,
			TransferID: fileID,
			FileID:     fileID,
			Offset:     offset,
			Length:     wsprotocol.ChunkSize,
			Action:     "request",
			Direction:  "download",
		}
		if err := e.WS.SendJSON(req); err != nil {
			return err
		}
		ev, err := e.wait(ch, 45*time.Second)
		if err != nil {
			return err
		}
		if ev.Header.Action == "error" {
			return fmt.Errorf("download chunk: %s", ev.Header.Message)
		}
		data := ev.Payload
		if ev.Header.Codec == "zstd" {
			raw, err := decompress(data)
			if err != nil {
				return err
			}
			data = raw
		}
		if ev.Header.Offset < 0 || ev.Header.Offset > client.MaxUploadBytes() {
			return fmt.Errorf("too_large")
		}
		if ev.Header.Offset+int64(len(data)) > client.MaxUploadBytes() {
			return fmt.Errorf("too_large")
		}
		if _, err := f.WriteAt(data, ev.Header.Offset); err != nil {
			return err
		}
		offset = ev.Header.Offset + int64(len(data))
		if size == 0 {
			size = ev.Header.TotalSize
		}
		if progress != nil && size > 0 {
			progress(int(offset * 100 / size))
		}
		if ev.Header.Final || (size > 0 && offset >= size) {
			break
		}
	}
	if offset < size {
		return fmt.Errorf("download incomplete")
	}
	if progress != nil {
		progress(100)
	}
	return nil
}

func (e *Engine) ReceiveE2EChunk(plain []byte, resolve func(string) (string, error)) error {
	header, payload, err := e2e.DecodeChunkPlain(plain)
	if err != nil {
		return err
	}
	if header.RemotePath == "" {
		return fmt.Errorf("missing dest")
	}
	dest := header.RemotePath
	if resolve != nil {
		dest, err = resolve(header.RemotePath)
		if err != nil {
			return err
		}
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.WriteAt(payload, header.Offset); err != nil {
		return err
	}
	return nil
}

func (e *Engine) uploadE2E(localPath, remotePath string, size int64, progress func(int)) error {
	f, err := os.Open(localPath)
	if err != nil {
		return err
	}
	defer f.Close()
	transferID := filepath.Base(localPath) + fmt.Sprintf("-%d", time.Now().UnixNano())
	buf := make([]byte, wsprotocol.ChunkSize)
	var offset int64
	for offset < size {
		n, err := f.Read(buf)
		if err != nil && !errors.Is(err, io.EOF) {
			return err
		}
		if n == 0 {
			break
		}
		header := wsprotocol.FileChunk{
			Type:       wsprotocol.TypeFileChunk,
			TransferID: transferID,
			Offset:     offset,
			Length:     int64(n),
			TotalSize:  size,
			Final:      offset+int64(n) >= size,
			Direction:  "upload",
			Action:     "data",
			RemotePath: remotePath,
		}
		plain, err := e2e.EncodeChunkPlain(header, buf[:n])
		if err != nil {
			return err
		}
		env, err := e.E2E.Seal("file_chunk", plain, "")
		if err != nil {
			return err
		}
		if err := e.WS.SendE2EEnvelope(env); err != nil {
			return err
		}
		offset += int64(n)
		if progress != nil && size > 0 {
			progress(int(offset * 100 / size))
		}
	}
	if progress != nil {
		progress(100)
	}
	return nil
}

func (e *Engine) arm(id string) chan chunkEvent {
	w := &waiter{ch: make(chan chunkEvent, 32), closed: make(chan struct{})}
	e.mu.Lock()
	if old := e.waiters[id]; old != nil {
		closeWaiter(old)
	}
	e.waiters[id] = w
	e.mu.Unlock()
	return w.ch
}

func (e *Engine) disarm(id string) {
	e.mu.Lock()
	w := e.waiters[id]
	delete(e.waiters, id)
	e.mu.Unlock()
	closeWaiter(w)
}

func closeWaiter(w *waiter) {
	if w == nil {
		return
	}
	select {
	case <-w.closed:
	default:
		close(w.closed)
	}
}

func (e *Engine) wait(ch chan chunkEvent, d time.Duration) (chunkEvent, error) {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case ev := <-ch:
		return ev, nil
	case <-t.C:
		return chunkEvent{}, fmt.Errorf("chunk timeout")
	}
}

func compress(raw []byte) ([]byte, bool) {
	enc, err := zstd.NewWriter(nil)
	if err != nil {
		return nil, false
	}
	out := enc.EncodeAll(raw, nil)
	_ = enc.Close()
	if len(out) >= len(raw) {
		return nil, false
	}
	return out, true
}

func decompress(raw []byte) ([]byte, error) {
	dec, err := zstd.NewReader(nil, zstd.WithDecoderMaxMemory(8<<20))
	if err != nil {
		return nil, err
	}
	defer dec.Close()
	return dec.DecodeAll(raw, nil)
}
