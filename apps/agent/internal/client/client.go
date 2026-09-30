package client

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pc-manager/agent/internal/config"
)

const (
	MaxScreenshotBytes    int64 = 8 << 20
	MaxUpdateBytes        int64 = 100 << 20
	downloadSlack         int64 = 1 << 20
	defaultMaxUploadBytes int64 = 512 << 20
)

var uploadCap atomic.Int64

func init() {
	uploadCap.Store(defaultMaxUploadBytes)
}

func MaxUploadBytes() int64 {
	n := uploadCap.Load()
	if n <= 0 {
		return defaultMaxUploadBytes
	}
	return n
}

func ApplyMaxUploadBytes(n int64) {
	if n > 0 {
		uploadCap.Store(n)
	}
}

type Client struct {
	cfg   *config.Config
	http  *http.Client
	probe *http.Client
	base  string
	mu    sync.Mutex
}

type Command struct {
	ID        string          `json:"id"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
	CreatedAt string          `json:"createdAt"`
}

type WatchConfig struct {
	IntervalMs int `json:"intervalMs"`
}

type AgentConfig struct {
	HeartbeatIntervalSec  int         `json:"heartbeatIntervalSec"`
	IdleHeartbeatSec      int         `json:"idleHeartbeatSec"`
	WatchedHeartbeatSec   int         `json:"watchedHeartbeatSec"`
	PollIntervalSec       int         `json:"pollIntervalSec"`
	ScreenshotIntervalSec *int        `json:"screenshotIntervalSec"`
	AutoRestartTime       *string     `json:"autoRestartTime"`
	SandboxRoots          []string    `json:"sandboxRoots"`
	Lightweight           *bool       `json:"lightweight"`
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

type HeartbeatResponse struct {
	OK          bool         `json:"ok"`
	ServerTime  string       `json:"serverTime"`
	Watch       *WatchConfig `json:"watch"`
	AgentConfig *AgentConfig `json:"agentConfig"`
}

func New(cfg *config.Config) *Client {
	transport := &http.Transport{
		Proxy:               http.ProxyFromEnvironment,
		DisableKeepAlives:   false,
		MaxIdleConns:        2,
		MaxIdleConnsPerHost: 1,
		IdleConnTimeout:     90 * time.Second,
	}
	return &Client{
		cfg:  cfg,
		http: &http.Client{Timeout: 90 * time.Second, Transport: transport},
		probe: &http.Client{
			Timeout:   5 * time.Second,
			Transport: transport,
		},
		base: strings.TrimRight(cfg.ServerURL, "/"),
	}
}

func (c *Client) setAuth(req *http.Request) {
	if c.cfg.DeviceID != "" {
		req.Header.Set("X-Device-Id", c.cfg.DeviceID)
	}
	if c.cfg.DeviceKey != "" {
		req.Header.Set("X-Enrollment-Key", c.cfg.DeviceKey)
	}
}

func (c *Client) orderedEndpoints() []string {
	all := c.cfg.Endpoints()
	c.mu.Lock()
	active := strings.TrimRight(c.base, "/")
	c.mu.Unlock()
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

// do sends req, retrying across endpoints when the body is rewindable
// (nil body or GetBody). do does not sleep; callers own backoff.
func (c *Client) do(req *http.Request) (*http.Response, error) {
	c.setAuth(req)
	if req.Header.Get("Content-Type") == "" && (req.Body != nil || req.GetBody != nil) {
		req.Header.Set("Content-Type", "application/json")
	}
	rewindable := req.Body == nil || req.GetBody != nil
	bases := c.orderedEndpoints()
	if !rewindable && len(bases) > 1 {
		bases = bases[:1]
	}
	path := req.URL.Path
	query := req.URL.RawQuery
	var lastErr error
	for _, base := range bases {
		body, err := requestBody(req)
		if err != nil {
			return nil, err
		}
		cloned, err := http.NewRequest(req.Method, strings.TrimRight(base, "/")+path, body)
		if err != nil {
			bodyClose(body)
			lastErr = err
			continue
		}
		cloned.Header = req.Header.Clone()
		cloned.URL.RawQuery = query
		cloned.ContentLength = req.ContentLength
		cloned.GetBody = req.GetBody
		resp, err := c.http.Do(cloned)
		if err != nil {
			lastErr = err
			continue
		}
		if resp.StatusCode >= 500 {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			lastErr = fmt.Errorf("http %d", resp.StatusCode)
			continue
		}
		c.mu.Lock()
		c.base = base
		c.mu.Unlock()
		return resp, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("all endpoints failed")
	}
	return nil, lastErr
}

func requestBody(req *http.Request) (io.Reader, error) {
	if req.GetBody != nil {
		return req.GetBody()
	}
	return req.Body, nil
}

func bodyClose(body io.Reader) {
	if c, ok := body.(io.Closer); ok {
		_ = c.Close()
	}
}

type HTTPStatusError struct {
	Status int
	Body   string
}

func (e *HTTPStatusError) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("http %d", e.Status)
	}
	return fmt.Sprintf("http %d: %s", e.Status, e.Body)
}

func IsClientError(err error) bool {
	var he *HTTPStatusError
	return errors.As(err, &he) && he.Status >= 400 && he.Status < 500
}

func DeviceExists(err error) (deviceID, hostname string, ok bool) {
	var he *HTTPStatusError
	if !errors.As(err, &he) || he.Status != http.StatusConflict {
		return "", "", false
	}
	var parsed struct {
		Error    string `json:"error"`
		DeviceID string `json:"deviceId"`
		Hostname string `json:"hostname"`
		Details  struct {
			DeviceID string `json:"deviceId"`
			Hostname string `json:"hostname"`
		} `json:"details"`
	}
	if json.Unmarshal([]byte(he.Body), &parsed) != nil {
		return "", "", true
	}
	if parsed.Error != "device_exists" {
		return "", "", false
	}
	id := parsed.DeviceID
	if id == "" {
		id = parsed.Details.DeviceID
	}
	host := parsed.Hostname
	if host == "" {
		host = parsed.Details.Hostname
	}
	return id, host, true
}

func decode(resp *http.Response, dest any) error {
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	if err != nil {
		return err
	}
	if resp.StatusCode >= 300 {
		return &HTTPStatusError{Status: resp.StatusCode, Body: strings.TrimSpace(string(body))}
	}
	if dest == nil {
		return nil
	}
	return json.Unmarshal(body, dest)
}

func (c *Client) doJSON(method, path string, payload any, dest any) error {
	var raw []byte
	if payload != nil {
		var err error
		raw, err = json.Marshal(payload)
		if err != nil {
			return err
		}
	}
	var body io.Reader
	if raw != nil {
		body = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, path, body)
	if err != nil {
		return err
	}
	if raw != nil {
		req.GetBody = func() (io.ReadCloser, error) {
			return io.NopCloser(bytes.NewReader(raw)), nil
		}
		req.ContentLength = int64(len(raw))
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	return decode(resp, dest)
}

func (c *Client) doStream(method, path, contentType string, getBody func() (io.ReadCloser, error), contentLength int64) error {
	return c.doStreamInto(method, path, contentType, getBody, contentLength, nil)
}

func (c *Client) doStreamInto(method, path, contentType string, getBody func() (io.ReadCloser, error), contentLength int64, dest any) error {
	req, err := http.NewRequest(method, path, nil)
	if err != nil {
		return err
	}
	req.GetBody = getBody
	req.Header.Set("Content-Type", contentType)
	req.ContentLength = contentLength
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	return decode(resp, dest)
}

func (c *Client) Probe() (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var lastErr error
	for _, base := range c.cfg.Endpoints() {
		url := strings.TrimRight(base, "/") + "/healthz"
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		if err != nil {
			lastErr = err
			continue
		}
		resp, err := c.probe.Do(req)
		if err != nil {
			lastErr = err
			continue
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		_ = resp.Body.Close()
		if resp.StatusCode >= 400 {
			lastErr = fmt.Errorf("healthz %d", resp.StatusCode)
			continue
		}
		c.mu.Lock()
		c.base = strings.TrimRight(base, "/")
		c.mu.Unlock()
		return c.base, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("all endpoints failed")
	}
	return "", lastErr
}

func (c *Client) ActiveEndpoint() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.base
}

func (c *Client) SetActiveEndpoint(base string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.base = strings.TrimRight(base, "/")
}

func (c *Client) WsChallenge() (string, error) {
	var out struct {
		Nonce string `json:"nonce"`
	}
	if err := c.doJSON(http.MethodPost, "/api/v1/agent/ws-challenge", map[string]any{}, &out); err != nil {
		return "", err
	}
	if out.Nonce == "" {
		return "", fmt.Errorf("empty ws challenge")
	}
	return out.Nonce, nil
}

func (c *Client) Enroll(payload map[string]any) (deviceID, deviceKey string, mesh *MeshBundle, err error) {
	var out struct {
		DeviceID  string      `json:"deviceId"`
		DeviceKey string      `json:"deviceKey"`
		Mesh      *MeshBundle `json:"mesh"`
	}
	if err := c.doJSON(http.MethodPost, "/api/v1/agent/register", payload, &out); err != nil {
		return "", "", nil, err
	}
	return out.DeviceID, out.DeviceKey, out.Mesh, nil
}

type TransferInfo struct {
	ID     string `json:"id"`
	Offset int64  `json:"offset"`
	Size   int64  `json:"size"`
	Status string `json:"status"`
}

func (c *Client) InitUpload(remotePath string, size int64) (*TransferInfo, error) {
	var out TransferInfo
	if err := c.doJSON(http.MethodPost, "/api/v1/agent/files/transfers", map[string]any{
		"remotePath": remotePath,
		"size":       size,
	}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) TransferMeta(id string) (*TransferInfo, error) {
	var out TransferInfo
	if err := c.doJSON(http.MethodGet, "/api/v1/agent/files/transfers/"+id, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) PostMetrics(payload any) error {
	return c.doJSON(http.MethodPost, "/api/v1/agent/metrics", payload, nil)
}

func (c *Client) Heartbeat(payload any) (*HeartbeatResponse, error) {
	var out HeartbeatResponse
	if err := c.doJSON(http.MethodPost, "/api/v1/agent/heartbeat", payload, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) PollCommands(waitSec int) ([]Command, error) {
	var out struct {
		Commands []Command `json:"commands"`
	}
	if err := c.doJSON(http.MethodGet, fmt.Sprintf("/api/v1/agent/commands?wait=%d", waitSec), nil, &out); err != nil {
		return nil, err
	}
	return out.Commands, nil
}

func (c *Client) CommandResult(commandID, resultID, status string, result any) error {
	err := c.commandResultOnce(commandID, resultID, status, result, nil)
	if err == nil || IsClientError(err) {
		return err
	}
	time.Sleep(time.Second)
	return c.commandResultOnce(commandID, resultID, status, result, nil)
}

func (c *Client) CommandProgress(commandID, resultID string, progress int) {
	p := progress
	_ = c.commandResultOnce(commandID, resultID, "running", map[string]any{"progress": p}, &p)
}

func (c *Client) commandResultOnce(commandID, resultID, status string, result any, progress *int) error {
	payload := map[string]any{"commandId": commandID, "resultId": resultID, "status": status, "result": result}
	if progress != nil {
		payload["progress"] = *progress
	}
	return c.doJSON(http.MethodPost, "/api/v1/agent/command-result", payload, nil)
}

func (c *Client) Logs(entries []map[string]any) error {
	if len(entries) == 0 {
		return nil
	}
	return c.doJSON(http.MethodPost, "/api/v1/agent/logs", map[string]any{"entries": entries}, nil)
}

func (c *Client) UploadScreenshot(jpeg []byte) error {
	if int64(len(jpeg)) > MaxScreenshotBytes {
		return fmt.Errorf("screenshot too large")
	}
	raw, contentType, err := encodeScreenshot(jpeg)
	if err != nil {
		return err
	}
	getBody := func() (io.ReadCloser, error) {
		return io.NopCloser(bytes.NewReader(raw)), nil
	}
	return c.doStream(http.MethodPost, "/api/v1/agent/screenshot", contentType, getBody, int64(len(raw)))
}

func encodeScreenshot(jpeg []byte) ([]byte, string, error) {
	var buf bytes.Buffer
	w := multipart.NewWriter(&buf)
	part, err := w.CreateFormFile("file", "screenshot.jpg")
	if err != nil {
		return nil, "", err
	}
	if _, err := part.Write(jpeg); err != nil {
		return nil, "", err
	}
	if err := w.Close(); err != nil {
		return nil, "", err
	}
	return buf.Bytes(), w.FormDataContentType(), nil
}

func (c *Client) UploadFile(localPath, remotePath string) error {
	_, err := c.UploadFileID(localPath, remotePath)
	return err
}

func (c *Client) UploadFileID(localPath, remotePath string) (string, error) {
	st, err := os.Stat(localPath)
	if err != nil {
		return "", err
	}
	if st.IsDir() {
		return "", fmt.Errorf("not a file")
	}
	if st.Size() > MaxUploadBytes() {
		return "", fmt.Errorf("too_large")
	}
	boundary, err := randomBoundary()
	if err != nil {
		return "", err
	}
	getBody := fileUploadGetBody(localPath, remotePath, boundary)
	ct := "multipart/form-data; boundary=" + boundary
	var out struct {
		ID string `json:"id"`
	}
	if err := c.doStreamInto(http.MethodPost, "/api/v1/agent/files", ct, getBody, -1, &out); err != nil {
		return "", err
	}
	return out.ID, nil
}

func fileUploadGetBody(localPath, remotePath, boundary string) func() (io.ReadCloser, error) {
	return func() (io.ReadCloser, error) {
		pr, pw := io.Pipe()
		go func() {
			w := multipart.NewWriter(pw)
			if err := w.SetBoundary(boundary); err != nil {
				_ = pw.CloseWithError(err)
				return
			}
			if err := w.WriteField("remotePath", remotePath); err != nil {
				_ = pw.CloseWithError(err)
				return
			}
			f, err := os.Open(localPath)
			if err != nil {
				_ = pw.CloseWithError(err)
				return
			}
			defer f.Close()
			part, err := w.CreateFormFile("file", filepath.Base(localPath))
			if err != nil {
				_ = pw.CloseWithError(err)
				return
			}
			if _, err := io.Copy(part, io.LimitReader(f, MaxUploadBytes()+1)); err != nil {
				_ = pw.CloseWithError(err)
				return
			}
			if err := w.Close(); err != nil {
				_ = pw.CloseWithError(err)
				return
			}
			_ = pw.Close()
		}()
		return pr, nil
	}
}

func randomBoundary() (string, error) {
	var b [12]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	return "pcmgr" + hex.EncodeToString(b[:]), nil
}

func (c *Client) DownloadFile(id, dest string, offset int64) error {
	path := "/api/v1/agent/files?id=" + id
	if offset > 0 {
		path += fmt.Sprintf("&offset=%d", offset)
	}
	req, err := http.NewRequest(http.MethodGet, path, nil)
	if err != nil {
		return err
	}
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("download http %d", resp.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return err
	}
	flag := os.O_CREATE | os.O_WRONLY
	if offset == 0 {
		flag |= os.O_TRUNC
	}
	out, err := os.OpenFile(dest, flag, 0o644)
	if err != nil {
		return err
	}
	defer out.Close()
	if offset > 0 {
		if _, err := out.Seek(offset, io.SeekStart); err != nil {
			return err
		}
	}
	n, err := io.Copy(out, io.LimitReader(resp.Body, MaxUploadBytes()+1-offset))
	if err != nil {
		if offset == 0 {
			_ = os.Remove(dest)
		}
		return err
	}
	if offset+n > MaxUploadBytes() {
		_ = os.Remove(dest)
		return fmt.Errorf("too_large")
	}
	return nil
}

type UpdateInfo struct {
	ID       string `json:"id"`
	Version  string `json:"version"`
	Notes    string `json:"notes"`
	Checksum string `json:"checksum"`
	Size     int    `json:"size"`
	URL      string `json:"url"`
}

func (c *Client) LatestUpdate() (*UpdateInfo, error) {
	var out struct {
		Update *UpdateInfo `json:"update"`
	}
	if err := c.doJSON(http.MethodGet, "/api/v1/agent/update", nil, &out); err != nil {
		return nil, err
	}
	return out.Update, nil
}

func (c *Client) DownloadURL(url, dest string, expectedSize int64) error {
	if expectedSize > MaxUpdateBytes {
		return fmt.Errorf("download exceeds size limit")
	}
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	c.setAuth(req)
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("download http %d", resp.StatusCode)
	}
	if resp.ContentLength > MaxUpdateBytes {
		return fmt.Errorf("download exceeds size limit")
	}
	if expectedSize > 0 && resp.ContentLength > expectedSize+downloadSlack {
		return fmt.Errorf("download exceeds size limit")
	}
	out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	n, copyErr := io.Copy(out, io.LimitReader(resp.Body, MaxUpdateBytes+1))
	closeErr := out.Close()
	if copyErr != nil {
		_ = os.Remove(dest)
		return copyErr
	}
	if n > MaxUpdateBytes {
		_ = os.Remove(dest)
		return fmt.Errorf("download exceeds size limit")
	}
	if expectedSize > 0 && n < expectedSize {
		_ = os.Remove(dest)
		return fmt.Errorf("download truncated: got %d want %d", n, expectedSize)
	}
	return closeErr
}

type PluginMeta struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	Version        string `json:"version"`
	Runtime        string `json:"runtime"`
	Platform       string `json:"platform"`
	Arch           string `json:"arch"`
	SHA256         string `json:"sha256"`
	TimeoutSec     int    `json:"timeoutSec"`
	NetworkAllowed bool   `json:"networkAllowed"`
	Size           int    `json:"size"`
}

func validatePluginID(id string) error {
	if id == "" || len(id) > 128 {
		return fmt.Errorf("invalid plugin id")
	}
	for _, r := range id {
		ok := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_'
		if !ok {
			return fmt.Errorf("invalid plugin id")
		}
	}
	return nil
}

func (c *Client) PluginMeta(id string) (*PluginMeta, error) {
	if err := validatePluginID(id); err != nil {
		return nil, err
	}
	var out struct {
		Plugin PluginMeta `json:"plugin"`
	}
	if err := c.doJSON(http.MethodGet, "/api/v1/agent/plugins/"+id, nil, &out); err != nil {
		return nil, err
	}
	if out.Plugin.ID == "" {
		return nil, fmt.Errorf("plugin not found")
	}
	return &out.Plugin, nil
}

func (c *Client) DownloadPlugin(id, dest string, expectedSize int64) error {
	if err := validatePluginID(id); err != nil {
		return err
	}
	if expectedSize > MaxUploadBytes() {
		return fmt.Errorf("plugin exceeds size limit")
	}
	req, err := http.NewRequest(http.MethodGet, "/api/v1/agent/plugins/"+id+"/blob", nil)
	if err != nil {
		return err
	}
	resp, err := c.do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		return fmt.Errorf("plugin download http %d", resp.StatusCode)
	}
	if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
		return err
	}
	out, err := os.Create(dest)
	if err != nil {
		return err
	}
	n, copyErr := io.Copy(out, io.LimitReader(resp.Body, MaxUploadBytes()+1))
	closeErr := out.Close()
	if copyErr != nil {
		_ = os.Remove(dest)
		return copyErr
	}
	if n > MaxUploadBytes() {
		_ = os.Remove(dest)
		return fmt.Errorf("plugin exceeds size limit")
	}
	if expectedSize > 0 && n < expectedSize {
		_ = os.Remove(dest)
		return fmt.Errorf("plugin download truncated: got %d want %d", n, expectedSize)
	}
	if closeErr != nil {
		_ = os.Remove(dest)
		return closeErr
	}
	return nil
}

type ModuleArgumentSpec struct {
	Name      string   `json:"name"`
	Type      string   `json:"type"`
	Required  bool     `json:"required"`
	MaxLength int      `json:"maxLength"`
	Choices   []string `json:"choices,omitempty"`
}

type ModuleMeta struct {
	ID              string               `json:"id"`
	DisplayName     string               `json:"displayName"`
	Version         string               `json:"version"`
	Kind            string               `json:"kind"`
	Platform        string               `json:"platform"`
	Arch            string               `json:"arch"`
	SHA256          string               `json:"sha256"`
	Size            int64                `json:"size"`
	Signer          string               `json:"signer"`
	Signature       string               `json:"signature"`
	PublicKey       string               `json:"publicKey"`
	Entrypoint      string               `json:"entrypoint"`
	Action          string               `json:"action"`
	ArgumentsSchema []ModuleArgumentSpec `json:"argumentsSchema"`
	TimeoutSec      int                  `json:"timeoutSec"`
	MaxOutputBytes  int                  `json:"maxOutputBytes"`
	NetworkAllowed  bool                 `json:"networkAllowed"`
	Enabled         bool                 `json:"enabled"`
	Revoked         bool                 `json:"revoked"`
	DownloadURL     string               `json:"downloadUrl"`
}

func (c *Client) FetchModuleMeta(id string) (*ModuleMeta, error) {
	if err := validatePluginID(id); err != nil {
		return nil, fmt.Errorf("invalid module id")
	}
	c.mu.Lock()
	activeBase := c.base
	c.mu.Unlock()
	if !secureModuleURL(activeBase) {
		return nil, fmt.Errorf("module transport requires HTTPS")
	}
	var out struct {
		Module ModuleMeta `json:"module"`
	}
	if err := c.doJSON(http.MethodGet, "/api/v1/agent/modules/"+id, nil, &out); err != nil {
		return nil, err
	}
	if out.Module.ID != id {
		return nil, fmt.Errorf("module metadata mismatch")
	}
	return &out.Module, nil
}

func (c *Client) DownloadModule(meta *ModuleMeta, dest string) error {
	if meta == nil || meta.DownloadURL == "" {
		return fmt.Errorf("module download URL missing")
	}
	if meta.Size <= 0 || meta.Size > MaxUpdateBytes {
		return fmt.Errorf("module exceeds size limit")
	}
	if !secureModuleURL(meta.DownloadURL) {
		return fmt.Errorf("module download requires HTTPS")
	}
	return c.DownloadURL(meta.DownloadURL, dest, meta.Size)
}

func secureModuleURL(raw string) bool {
	parsed, err := url.Parse(raw)
	if err != nil {
		return false
	}
	if parsed.Scheme == "https" {
		return true
	}
	if parsed.Scheme != "http" {
		return false
	}
	host := strings.ToLower(parsed.Hostname())
	return host == "localhost" || host == "127.0.0.1" || host == "::1"
}
