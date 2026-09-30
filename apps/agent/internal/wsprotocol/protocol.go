package wsprotocol

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"time"
)

const (
	Path               = "/agent-ws"
	NonceQuery         = "nonce"
	ProtocolVersion    = 1
	PingInterval       = 45 * time.Second
	StaleAfter         = 90 * time.Second
	HelloTimeout       = 10 * time.Second
	FallbackAfterFails = 3
)

const (
	TypeHello           = "hello"
	TypeHelloOK         = "hello_ok"
	TypePing            = "ping"
	TypePong            = "pong"
	TypeCommand         = "command"
	TypeCommandAck      = "command_ack"
	TypeCommandCancel   = "command_cancel"
	TypeCommandResult   = "command_result"
	TypeHeartbeat       = "heartbeat"
	TypeAgentConfig     = "agent_config"
	TypeScreenshotBin   = "screenshot_bin"
	TypeFileChunk       = "file_chunk"
	TypeWebrtcSignal    = "webrtc_signal"
	TypeMeshSignal      = "mesh_signal"
	TypeMeshRelay       = "mesh_relay"
	TypeMeshRelayResult = "mesh_relay_result"
	TypeE2EEnvelope     = "e2e_envelope"
	TypeShellOpen       = "shell_open"
	TypeShellData       = "shell_data"
	TypeShellResize     = "shell_resize"
	TypeShellClose      = "shell_close"
	TypeShellExec       = "shell_exec"
)

const (
	BinScreenshotBin byte = 1
	BinFileChunk     byte = 2
	BinE2EEnvelope   byte = 3
	BinShellData     byte = 4
)

type Hello struct {
	Type         string   `json:"type"`
	DeviceID     string   `json:"deviceId"`
	KeyProof     string   `json:"keyProof"`
	AgentVersion string   `json:"agentVersion,omitempty"`
	E2EPub       string   `json:"e2ePub,omitempty"`
	LanAddrs     []string `json:"lanAddrs"`
	LanPort      int      `json:"lanPort,omitempty"`
	MeshSerial   string   `json:"meshSerial,omitempty"`
}

type Caps struct {
	Zstd   bool `json:"zstd"`
	Webrtc bool `json:"webrtc"`
	E2E    bool `json:"e2e"`
}

type WatchConfig struct {
	IntervalMs int `json:"intervalMs"`
}

type AgentConfig struct {
	HeartbeatIntervalSec  int         `json:"heartbeatIntervalSec"`
	IdleHeartbeatSec      int         `json:"idleHeartbeatSec,omitempty"`
	WatchedHeartbeatSec   int         `json:"watchedHeartbeatSec,omitempty"`
	PollIntervalSec       int         `json:"pollIntervalSec"`
	ScreenshotIntervalSec *int        `json:"screenshotIntervalSec"`
	AutoRestartTime       *string     `json:"autoRestartTime"`
	SandboxRoots          []string    `json:"sandboxRoots"`
	Lightweight           *bool       `json:"lightweight,omitempty"`
	MaxUploadBytes        int64       `json:"maxUploadBytes,omitempty"`
	Mesh                  *MeshPolicy `json:"mesh,omitempty"`
}

type MeshPolicy struct {
	Enabled       bool     `json:"enabled"`
	WAN           bool     `json:"wan,omitempty"`
	AllowCommands []string `json:"allowCommands,omitempty"`
}

type MeshBundle struct {
	Cert           string   `json:"cert"`
	Key            string   `json:"key,omitempty"`
	CA             string   `json:"ca"`
	Serial         string   `json:"serial,omitempty"`
	NotAfter       string   `json:"notAfter,omitempty"`
	RevokedSerials []string `json:"revokedSerials,omitempty"`
}

type HelloOK struct {
	Type            string         `json:"type"`
	ServerTime      string         `json:"serverTime"`
	ProtocolVersion int            `json:"protocolVersion"`
	Watch           *WatchConfig   `json:"watch"`
	AgentConfig     AgentConfig    `json:"agentConfig"`
	Caps            *Caps          `json:"caps,omitempty"`
	Mesh            *MeshBundle    `json:"mesh,omitempty"`
	IceServers      []IceServer    `json:"iceServers,omitempty"`
	IP              string         `json:"ip,omitempty"`
	MeshPeers       []MeshPeerHint `json:"meshPeers,omitempty"`
}

type IceServer struct {
	URLs       json.RawMessage `json:"urls"`
	Username   string          `json:"username,omitempty"`
	Credential string          `json:"credential,omitempty"`
}

type MeshPeerHint struct {
	ID       string   `json:"id"`
	LanAddrs []string `json:"lanAddrs,omitempty"`
	IP       string   `json:"ip,omitempty"`
	LanPort  int      `json:"lanPort,omitempty"`
}

type Ping struct {
	Type string `json:"type"`
	TS   int64  `json:"ts,omitempty"`
}

type Pong struct {
	Type string `json:"type"`
	TS   int64  `json:"ts,omitempty"`
}

type Command struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	CmdType   string          `json:"cmdType"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt string          `json:"createdAt"`
}

type CommandAck struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type CommandCancel struct {
	Type string `json:"type"`
	ID   string `json:"id"`
}

type CommandResult struct {
	Type      string `json:"type"`
	CommandID string `json:"commandId"`
	ResultID  string `json:"resultId"`
	Status    string `json:"status"`
	Result    any    `json:"result,omitempty"`
	Progress  *int   `json:"progress,omitempty"`
}

type Heartbeat struct {
	Type      string          `json:"type"`
	CPU       float64         `json:"cpu,omitempty"`
	RAM       float64         `json:"ram,omitempty"`
	Disk      float64         `json:"disk,omitempty"`
	GPU       *float64        `json:"gpu,omitempty"`
	Temp      *float64        `json:"temp,omitempty"`
	NetUp     float64         `json:"netUp,omitempty"`
	NetDown   float64         `json:"netDown,omitempty"`
	Processes json.RawMessage `json:"processes,omitempty"`
	Extras    json.RawMessage `json:"extras,omitempty"`
	LanAddrs  []string        `json:"lanAddrs,omitempty"`
	LanPort   int             `json:"lanPort,omitempty"`
}

type ShellOpen struct {
	Type  string `json:"type"`
	Shell string `json:"shell,omitempty"`
	Cols  int    `json:"cols,omitempty"`
	Rows  int    `json:"rows,omitempty"`
}

type ShellData struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
}

type ShellResize struct {
	Type string `json:"type"`
	Cols int    `json:"cols"`
	Rows int    `json:"rows"`
}

type ShellClose struct {
	Type   string `json:"type"`
	Reason string `json:"reason,omitempty"`
}

type ShellExec struct {
	Type     string `json:"type"`
	ID       string `json:"id"`
	Command  string `json:"command,omitempty"`
	Shell    string `json:"shell,omitempty"`
	Data     string `json:"data,omitempty"`
	Done     bool   `json:"done,omitempty"`
	ExitCode *int   `json:"exitCode,omitempty"`
	Error    string `json:"error,omitempty"`
}

type AgentConfigFrame struct {
	Type        string         `json:"type"`
	ServerTime  string         `json:"serverTime"`
	Watch       *WatchConfig   `json:"watch"`
	AgentConfig AgentConfig    `json:"agentConfig"`
	IceServers  []IceServer    `json:"iceServers,omitempty"`
	IP          string         `json:"ip,omitempty"`
	MeshPeers   []MeshPeerHint `json:"meshPeers,omitempty"`
}

type ScreenshotBin struct {
	ContentType string `json:"contentType,omitempty"`
}

type FileChunk struct {
	Type       string `json:"type,omitempty"`
	TransferID string `json:"transferId"`
	Offset     int64  `json:"offset"`
	Length     int64  `json:"length"`
	TotalSize  int64  `json:"totalSize,omitempty"`
	Final      bool   `json:"final,omitempty"`
	Codec      string `json:"codec,omitempty"`
	Direction  string `json:"direction,omitempty"`
	Action     string `json:"action,omitempty"`
	RemotePath string `json:"remotePath,omitempty"`
	FileID     string `json:"fileId,omitempty"`
	Message    string `json:"message,omitempty"`
}

type E2EBinHeader struct {
	SessionID string `json:"sessionId"`
	Kind      string `json:"kind"`
	Nonce     string `json:"nonce"`
	AAD       string `json:"aad,omitempty"`
}

type WebrtcSignal struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

type MeshSignalPayload struct {
	SessionID string `json:"sessionId"`
	To        string `json:"to"`
	From      string `json:"from,omitempty"`
	Kind      string `json:"kind"`
	SDP       string `json:"sdp,omitempty"`
	SDPType   string `json:"sdpType,omitempty"`
	Candidate any    `json:"candidate,omitempty"`
}

type MeshSignal struct {
	Type    string            `json:"type"`
	Payload MeshSignalPayload `json:"payload"`
}

type MeshRelay struct {
	Type     string          `json:"type"`
	To       string          `json:"to"`
	From     string          `json:"from,omitempty"`
	CmdType  string          `json:"cmdType"`
	Payload  json.RawMessage `json:"payload,omitempty"`
	ResultID string          `json:"resultId"`
}

type MeshRelayResult struct {
	Type     string `json:"type"`
	To       string `json:"to"`
	From     string `json:"from,omitempty"`
	ResultID string `json:"resultId"`
	Status   string `json:"status"`
	Result   any    `json:"result,omitempty"`
}

type E2EEnvelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

const (
	ChunkSize    = 1 << 20
	ZstdMin      = 1 << 20
	HTTPFallback = 1 << 20
	E2EInfo      = "pc-manager-e2e-v1"
	E2ESaltLen   = 32
	DefaultSTUN  = "stun:stun.l.google.com:19302"
)

func KeyProof(deviceKey, nonce string) string {
	mac := hmac.New(sha256.New, []byte(deviceKey))
	_, _ = mac.Write([]byte(nonce))
	return hex.EncodeToString(mac.Sum(nil))
}

func NewNonce() (string, error) {
	var b [32]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(b[:]), nil
}

func EncodeBinary(binType byte, header any, payload []byte) ([]byte, error) {
	h, err := json.Marshal(header)
	if err != nil {
		return nil, err
	}
	if len(h) > 0xffff {
		return nil, fmt.Errorf("agent-ws header too large")
	}
	out := make([]byte, 3+len(h)+len(payload))
	out[0] = binType
	binary.BigEndian.PutUint16(out[1:3], uint16(len(h)))
	copy(out[3:], h)
	copy(out[3+len(h):], payload)
	return out, nil
}

func DecodeBinary(frame []byte) (binType byte, header json.RawMessage, payload []byte, err error) {
	if len(frame) < 3 {
		return 0, nil, nil, fmt.Errorf("agent-ws binary frame too short")
	}
	binType = frame[0]
	headerLen := int(binary.BigEndian.Uint16(frame[1:3]))
	if 3+headerLen > len(frame) {
		return 0, nil, nil, fmt.Errorf("agent-ws binary header truncated")
	}
	return binType, json.RawMessage(frame[3 : 3+headerLen]), frame[3+headerLen:], nil
}
