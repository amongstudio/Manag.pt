package agentws

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/pc-manager/agent/internal/client"
	"github.com/pc-manager/agent/internal/config"
	"github.com/pc-manager/agent/internal/lan"
	"github.com/pc-manager/agent/internal/logger"
	"github.com/pc-manager/agent/internal/wsprotocol"
)

var errNotConnected = errors.New("agent-ws not connected")

type ConfigHandler func(ac *client.AgentConfig, watch *client.WatchConfig)

type Handlers struct {
	OnWebrtc          func(payload json.RawMessage)
	OnMeshSignal      func(payload json.RawMessage)
	OnMeshRelay       func(payload json.RawMessage)
	OnMeshRelayResult func(payload json.RawMessage)
	OnE2E             func(payload json.RawMessage)
	OnFileChunk       func(header wsprotocol.FileChunk, payload []byte)
	OnShell           func(typ string, payload json.RawMessage, bin []byte)
	OnCommandCancel   func(commandID string)
}

type Client struct {
	cfg        *config.Config
	http       *client.Client
	log        *logger.AgentLog
	version    string
	onConfig   ConfigHandler
	e2ePub     string
	handlers   Handlers
	onHello    func(ok wsprotocol.HelloOK)
	meshSerial func() string

	cmds      chan client.Command
	writeMu   sync.Mutex
	conn      *websocket.Conn
	connected atomic.Bool
	failures  atomic.Int32
	caps      atomic.Value
}

func New(cfg *config.Config, httpClient *client.Client, log *logger.AgentLog, version string, onConfig ConfigHandler) *Client {
	c := &Client{
		cfg:      cfg,
		http:     httpClient,
		log:      log,
		version:  version,
		onConfig: onConfig,
		cmds:     make(chan client.Command, 64),
	}
	c.caps.Store(wsprotocol.Caps{})
	return c
}

func (c *Client) SetE2EPub(pub string) {
	c.e2ePub = pub
}

func (c *Client) SetHandlers(h Handlers) {
	c.handlers = h
}

func (c *Client) SetOnHello(fn func(ok wsprotocol.HelloOK)) {
	c.onHello = fn
}

func (c *Client) SetMeshSerial(fn func() string) {
	c.meshSerial = fn
}

func (c *Client) CapsZstd() bool {
	caps, _ := c.caps.Load().(wsprotocol.Caps)
	return caps.Zstd
}

func (c *Client) Commands() <-chan client.Command {
	return c.cmds
}

func (c *Client) Connected() bool {
	return c.connected.Load()
}

func (c *Client) ShouldFallback() bool {
	return !c.connected.Load() && int(c.failures.Load()) >= wsprotocol.FallbackAfterFails
}

func (c *Client) Submit(cmd client.Command, stop <-chan struct{}) bool {
	select {
	case <-stop:
		return false
	case c.cmds <- cmd:
		return true
	}
}

func (c *Client) SendHeartbeat(snap any) error {
	raw, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	var body map[string]any
	if err := json.Unmarshal(raw, &body); err != nil {
		return err
	}
	body["type"] = wsprotocol.TypeHeartbeat
	return c.writeJSON(body)
}

func (c *Client) SendCommandResult(commandID, resultID, status string, result any, progress *int) error {
	frame := wsprotocol.CommandResult{
		Type:      wsprotocol.TypeCommandResult,
		CommandID: commandID,
		ResultID:  resultID,
		Status:    status,
		Result:    result,
		Progress:  progress,
	}
	return c.writeJSON(frame)
}

func (c *Client) SendJSON(v any) error {
	return c.writeJSON(v)
}

func (c *Client) SendFileChunk(header wsprotocol.FileChunk, payload []byte) error {
	frame, err := wsprotocol.EncodeBinary(wsprotocol.BinFileChunk, header, payload)
	if err != nil {
		return err
	}
	return c.writeBinary(frame)
}

func (c *Client) SendScreenshot(jpeg []byte) error {
	header := wsprotocol.ScreenshotBin{ContentType: "image/jpeg"}
	frame, err := wsprotocol.EncodeBinary(wsprotocol.BinScreenshotBin, header, jpeg)
	if err != nil {
		return err
	}
	return c.writeBinary(frame)
}

func (c *Client) SendE2EEnvelope(payload any) error {
	return c.writeJSON(map[string]any{"type": wsprotocol.TypeE2EEnvelope, "payload": payload})
}

func (c *Client) Run(stop <-chan struct{}) {
	backoff := time.Second
	const maxBackoff = 30 * time.Second
	for {
		select {
		case <-stop:
			c.closeConn()
			return
		default:
		}
		session, err := c.connectOnce(stop)
		select {
		case <-stop:
			c.closeConn()
			return
		default:
		}
		c.connected.Store(false)
		if err != nil {
			c.failures.Add(1)
			c.log.Notef("WARNING", "agent-ws: %v", err)
		}
		if session {
			backoff = time.Second
		}
		jitter := time.Duration(rand.Int64N(int64(time.Second)))
		delay := backoff + jitter
		if delay > maxBackoff {
			delay = maxBackoff
		}
		t := time.NewTimer(delay)
		select {
		case <-stop:
			t.Stop()
			c.closeConn()
			return
		case <-t.C:
		}
		if !session {
			backoff *= 2
			if backoff > maxBackoff {
				backoff = maxBackoff
			}
		}
	}
}

func (c *Client) connectOnce(stop <-chan struct{}) (bool, error) {
	nonce, err := c.http.WsChallenge()
	if err != nil {
		return false, fmt.Errorf("ws-challenge: %w", err)
	}
	var lastErr error
	for _, base := range c.endpoints() {
		select {
		case <-stop:
			return false, nil
		default:
		}
		wsURL, err := toWSURL(base, nonce)
		if err != nil {
			lastErr = err
			continue
		}
		hdr := http.Header{}
		hdr.Set("X-Device-Id", c.cfg.DeviceID)
		hdr.Set("X-Enrollment-Key", c.cfg.DeviceKey)
		dialer := websocket.Dialer{
			HandshakeTimeout: 8 * time.Second,
			Proxy:            http.ProxyFromEnvironment,
		}
		conn, _, err := dialer.Dial(wsURL, hdr)
		if err != nil {
			lastErr = err
			continue
		}
		if err := c.handshake(conn, nonce); err != nil {
			_ = conn.Close()
			lastErr = err
			continue
		}
		c.setConn(conn)
		c.http.SetActiveEndpoint(base)
		c.failures.Store(0)
		c.connected.Store(true)
		c.log.Notef("INFO", "agent-ws connected %s", base)
		err = c.readLoop(conn, stop)
		c.connected.Store(false)
		c.closeConn()
		return true, err
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("all agent-ws endpoints failed")
	}
	return false, lastErr
}

func (c *Client) handshake(conn *websocket.Conn, nonce string) error {
	hello := wsprotocol.Hello{
		Type:         wsprotocol.TypeHello,
		DeviceID:     c.cfg.DeviceID,
		KeyProof:     wsprotocol.KeyProof(c.cfg.DeviceKey, nonce),
		AgentVersion: c.version,
		E2EPub:       c.e2ePub,
		LanAddrs:     lan.Addrs(),
		LanPort:      lan.Port(),
	}
	if c.meshSerial != nil {
		hello.MeshSerial = c.meshSerial()
	}
	_ = conn.SetWriteDeadline(time.Now().Add(wsprotocol.HelloTimeout))
	if err := conn.WriteJSON(hello); err != nil {
		return fmt.Errorf("hello: %w", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(wsprotocol.HelloTimeout))
	var ok wsprotocol.HelloOK
	if err := conn.ReadJSON(&ok); err != nil {
		return fmt.Errorf("hello_ok: %w", err)
	}
	if ok.Type != wsprotocol.TypeHelloOK {
		return fmt.Errorf("expected hello_ok, got %s", ok.Type)
	}
	if ok.Caps != nil {
		c.caps.Store(*ok.Caps)
	}
	if c.onHello != nil {
		c.onHello(ok)
	}
	c.applyConfig(ok.AgentConfig, ok.Watch)
	return nil
}

func (c *Client) readLoop(conn *websocket.Conn, stop <-chan struct{}) error {
	conn.SetReadLimit(12 << 20)
	ping := time.NewTicker(wsprotocol.PingInterval)
	defer ping.Stop()
	connDone := make(chan struct{})
	defer close(connDone)
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-connDone:
				return
			case ts := <-ping.C:
				_ = c.writeJSON(wsprotocol.Ping{Type: wsprotocol.TypePing, TS: ts.UnixMilli()})
			}
		}
	}()
	for {
		select {
		case <-stop:
			return nil
		default:
		}
		_ = conn.SetReadDeadline(time.Now().Add(wsprotocol.StaleAfter))
		messageType, data, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		if messageType == websocket.BinaryMessage {
			c.handleBinary(data)
			continue
		}
		var probe struct {
			Type string `json:"type"`
		}
		if err := json.Unmarshal(data, &probe); err != nil {
			continue
		}
		switch probe.Type {
		case wsprotocol.TypePing:
			var ping wsprotocol.Ping
			_ = json.Unmarshal(data, &ping)
			_ = c.writeJSON(wsprotocol.Pong{Type: wsprotocol.TypePong, TS: ping.TS})
		case wsprotocol.TypePong:
		case wsprotocol.TypeHeartbeat, wsprotocol.TypeAgentConfig, wsprotocol.TypeHelloOK:
			var frame wsprotocol.AgentConfigFrame
			if err := json.Unmarshal(data, &frame); err != nil {
				continue
			}
			if probe.Type == wsprotocol.TypeHeartbeat && frame.AgentConfig.HeartbeatIntervalSec == 0 && frame.Watch == nil {
				continue
			}
			c.applyConfig(frame.AgentConfig, frame.Watch)
			if c.onHello != nil && (len(frame.IceServers) > 0 || frame.IP != "" || len(frame.MeshPeers) > 0) {
				c.onHello(wsprotocol.HelloOK{IceServers: frame.IceServers, IP: frame.IP, MeshPeers: frame.MeshPeers})
			}
		case wsprotocol.TypeCommand:
			var frame wsprotocol.Command
			if err := json.Unmarshal(data, &frame); err != nil {
				continue
			}
			cmd := client.Command{
				ID:        frame.ID,
				Type:      frame.CmdType,
				Payload:   frame.Payload,
				CreatedAt: frame.CreatedAt,
			}
			queued := false
			select {
			case <-stop:
				return nil
			case c.cmds <- cmd:
				queued = true
			default:
				select {
				case <-stop:
					return nil
				case c.cmds <- cmd:
					queued = true
				case <-time.After(5 * time.Second):
					c.log.Notef("WARNING", "ws command queue stalled (%s)", frame.ID)
					_ = c.writeJSON(wsprotocol.CommandResult{
						Type:      wsprotocol.TypeCommandResult,
						CommandID: frame.ID,
						ResultID:  uuid.NewString(),
						Status:    "failed",
						Result:    map[string]string{"error": "command queue stalled"},
					})
				}
			}
			if queued {
				_ = c.writeJSON(wsprotocol.CommandAck{Type: wsprotocol.TypeCommandAck, ID: frame.ID})
			}
		case wsprotocol.TypeCommandCancel:
			var frame wsprotocol.CommandCancel
			if err := json.Unmarshal(data, &frame); err != nil {
				continue
			}
			if c.handlers.OnCommandCancel != nil && frame.ID != "" {
				c.handlers.OnCommandCancel(frame.ID)
			}
		case wsprotocol.TypeWebrtcSignal:
			var frame wsprotocol.WebrtcSignal
			if err := json.Unmarshal(data, &frame); err != nil {
				continue
			}
			if c.handlers.OnWebrtc != nil {
				c.handlers.OnWebrtc(frame.Payload)
			}
		case wsprotocol.TypeMeshSignal:
			if c.handlers.OnMeshSignal != nil {
				c.handlers.OnMeshSignal(data)
			}
		case wsprotocol.TypeMeshRelay:
			if c.handlers.OnMeshRelay != nil {
				c.handlers.OnMeshRelay(data)
			}
		case wsprotocol.TypeMeshRelayResult:
			if c.handlers.OnMeshRelayResult != nil {
				c.handlers.OnMeshRelayResult(data)
			}
		case wsprotocol.TypeShellOpen, wsprotocol.TypeShellData, wsprotocol.TypeShellResize, wsprotocol.TypeShellClose, wsprotocol.TypeShellExec:
			if c.handlers.OnShell != nil {
				c.handlers.OnShell(probe.Type, data, nil)
			}
		case wsprotocol.TypeE2EEnvelope:
			var frame wsprotocol.E2EEnvelope
			if err := json.Unmarshal(data, &frame); err != nil {
				continue
			}
			if c.handlers.OnE2E != nil {
				c.handlers.OnE2E(frame.Payload)
			}
		case wsprotocol.TypeFileChunk:
			var header wsprotocol.FileChunk
			if err := json.Unmarshal(data, &header); err != nil {
				continue
			}
			if c.handlers.OnFileChunk != nil {
				c.handlers.OnFileChunk(header, nil)
			}
		}
	}
}

func (c *Client) applyConfig(ac wsprotocol.AgentConfig, watch *wsprotocol.WatchConfig) {
	if c.onConfig == nil {
		return
	}
	var roots []string
	if ac.SandboxRoots != nil {
		roots = append([]string(nil), ac.SandboxRoots...)
	}
	cfg := &client.AgentConfig{
		HeartbeatIntervalSec:  ac.HeartbeatIntervalSec,
		IdleHeartbeatSec:      ac.IdleHeartbeatSec,
		WatchedHeartbeatSec:   ac.WatchedHeartbeatSec,
		PollIntervalSec:       ac.PollIntervalSec,
		ScreenshotIntervalSec: ac.ScreenshotIntervalSec,
		AutoRestartTime:       ac.AutoRestartTime,
		SandboxRoots:          roots,
		Lightweight:           ac.Lightweight,
		MaxUploadBytes:        ac.MaxUploadBytes,
	}
	if ac.Mesh != nil {
		cfg.Mesh = &client.MeshPolicy{
			Enabled:       ac.Mesh.Enabled,
			WAN:           ac.Mesh.WAN,
			AllowCommands: append([]string(nil), ac.Mesh.AllowCommands...),
		}
	}
	var w *client.WatchConfig
	if watch != nil {
		w = &client.WatchConfig{IntervalMs: watch.IntervalMs}
	}
	c.onConfig(cfg, w)
}

func (c *Client) endpoints() []string {
	all := c.cfg.Endpoints()
	active := strings.TrimRight(c.http.ActiveEndpoint(), "/")
	if active == "" {
		return all
	}
	out := []string{active}
	for _, u := range all {
		if strings.TrimRight(u, "/") != active {
			out = append(out, u)
		}
	}
	return out
}

func (c *Client) writeJSON(v any) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	conn := c.conn
	if conn == nil {
		return errNotConnected
	}
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return conn.WriteJSON(v)
}

func (c *Client) writeBinary(p []byte) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	conn := c.conn
	if conn == nil {
		return errNotConnected
	}
	_ = conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
	return conn.WriteMessage(websocket.BinaryMessage, p)
}

func (c *Client) handleBinary(data []byte) {
	binType, header, payload, err := wsprotocol.DecodeBinary(data)
	if err != nil {
		return
	}
	switch binType {
	case wsprotocol.BinFileChunk:
		var h wsprotocol.FileChunk
		if err := json.Unmarshal(header, &h); err != nil {
			return
		}
		if c.handlers.OnFileChunk != nil {
			c.handlers.OnFileChunk(h, payload)
		}
	case wsprotocol.BinE2EEnvelope:
		var h wsprotocol.E2EBinHeader
		if err := json.Unmarshal(header, &h); err != nil {
			return
		}
		if c.handlers.OnE2E == nil {
			return
		}
		env := map[string]any{
			"action":     "data",
			"sessionId":  h.SessionID,
			"kind":       h.Kind,
			"nonce":      h.Nonce,
			"ciphertext": payload, // raw; handler should treat as bytes if needed
			"aad":        h.AAD,
		}
		raw, err := json.Marshal(env)
		if err != nil {
			return
		}
		c.handlers.OnE2E(raw)
	case wsprotocol.BinShellData:
		if c.handlers.OnShell != nil {
			c.handlers.OnShell(wsprotocol.TypeShellData, header, payload)
		}
	}
}

func (c *Client) setConn(conn *websocket.Conn) {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.conn != nil && c.conn != conn {
		_ = c.conn.Close()
	}
	c.conn = conn
}

func (c *Client) closeConn() {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if c.conn != nil {
		_ = c.conn.Close()
		c.conn = nil
	}
	c.connected.Store(false)
}

func toWSURL(httpBase, nonce string) (string, error) {
	u, err := url.Parse(strings.TrimRight(httpBase, "/"))
	if err != nil {
		return "", err
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		u.Scheme = "wss"
	default:
		u.Scheme = "ws"
	}
	u.Path = wsprotocol.Path
	q := u.Query()
	q.Set(wsprotocol.NonceQuery, nonce)
	u.RawQuery = q.Encode()
	return u.String(), nil
}
