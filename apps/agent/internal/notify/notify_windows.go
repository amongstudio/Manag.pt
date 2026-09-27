//go:build windows

package notify

import (
	"fmt"
	"io"
	"os"
	"strconv"
	"sync"
	"time"
	"unsafe"

	"github.com/pc-manager/agent/internal/winsession"
	"golang.org/x/sys/windows"
)

const (
	connectQuick  = 400 * time.Millisecond
	connectSpawn  = 8 * time.Second
	spawnCooldown = 3 * time.Second
)

var (
	sendMu             sync.Mutex
	spawnMu            sync.Mutex
	lastSpawn          time.Time
	procWaitNamedPipeW = windows.NewLazySystemDLL("kernel32.dll").NewProc("WaitNamedPipeW")
)

func waitNamedPipe(name *uint16, timeout uint32) error {
	r1, _, e1 := procWaitNamedPipeW.Call(uintptr(unsafe.Pointer(name)), uintptr(timeout))
	if r1 == 0 {
		if e1 != windows.ERROR_SUCCESS {
			return e1
		}
		return windows.ERROR_FILE_NOT_FOUND
	}
	return nil
}

func PipeSDDL(userSID string) string {
	sddl := "D:P(A;;GA;;;SY)(A;;GA;;;BA)"
	if userSID != "" {
		sddl += "(A;;GA;;;" + userSID + ")"
	}
	return sddl
}

func UserSID() string {
	if sid := processUserSID(); sid != "" {
		return sid
	}
	return consoleUserSID()
}

func processUserSID() string {
	var tok windows.Token
	err := windows.OpenProcessToken(windows.CurrentProcess(), windows.TOKEN_QUERY, &tok)
	if err != nil {
		return ""
	}
	defer tok.Close()
	u, err := tok.GetTokenUser()
	if err != nil {
		return ""
	}
	return u.User.Sid.String()
}

func consoleUserSID() string {
	tok, err := winsession.ImpersonationToken()
	if err != nil {
		return ""
	}
	defer tok.Close()
	u, err := tok.GetTokenUser()
	if err != nil {
		return ""
	}
	return u.User.Sid.String()
}

func PipeSecurity() (*windows.SecurityAttributes, error) {
	sd, err := windows.SecurityDescriptorFromString(PipeSDDL(UserSID()))
	if err != nil {
		return nil, err
	}
	return &windows.SecurityAttributes{
		Length:             uint32(unsafe.Sizeof(windows.SecurityAttributes{})),
		SecurityDescriptor: sd,
	}, nil
}

type pipeFile struct {
	h windows.Handle
}

func (p *pipeFile) Read(b []byte) (int, error) {
	if p == nil || p.h == 0 {
		return 0, io.EOF
	}
	var n uint32
	err := windows.ReadFile(p.h, b, &n, nil)
	if n > 0 {
		return int(n), nil
	}
	if err != nil {
		return 0, err
	}
	return 0, io.EOF
}

func (p *pipeFile) Write(b []byte) (int, error) {
	if p == nil || p.h == 0 {
		return 0, io.ErrClosedPipe
	}
	var n uint32
	err := windows.WriteFile(p.h, b, &n, nil)
	return int(n), err
}

func show(msg Message) error {
	sendMu.Lock()
	defer sendMu.Unlock()
	if !winsession.HasConsoleUser() {
		logf("notify: skip %s: no interactive session", msg.Kind)
		return nil
	}
	h, err := openPipe(connectQuick)
	if err != nil {
		if spawnErr := spawnTray(); spawnErr != nil {
			return fmt.Errorf("spawn tray: %w", spawnErr)
		}
		h, err = openPipe(connectSpawn)
		if err != nil {
			return err
		}
	}
	defer windows.CloseHandle(h)
	if err := WriteMessage(&pipeFile{h: h}, msg); err != nil {
		return err
	}
	_ = windows.FlushFileBuffers(h)
	return nil
}

func ensureTray() {
	go func() {
		if !winsession.HasConsoleUser() {
			return
		}
		if pipeReady(200) {
			return
		}
		_ = spawnTray()
	}()
}

func pipeReady(waitMs uint32) bool {
	name16, err := windows.UTF16PtrFromString(PipeName)
	if err != nil {
		return false
	}
	return waitNamedPipe(name16, waitMs) == nil
}

func openPipe(timeout time.Duration) (windows.Handle, error) {
	name16, err := windows.UTF16PtrFromString(PipeName)
	if err != nil {
		return 0, err
	}
	deadline := time.Now().Add(timeout)
	var last error
	for {
		h, err := windows.CreateFile(
			name16,
			windows.GENERIC_WRITE,
			0,
			nil,
			windows.OPEN_EXISTING,
			0,
			0,
		)
		if err == nil {
			return h, nil
		}
		last = err
		if err != windows.ERROR_FILE_NOT_FOUND && err != windows.ERROR_PIPE_BUSY {
			return 0, err
		}
		remain := time.Until(deadline)
		if remain <= 0 {
			if last == nil {
				last = fmt.Errorf("notify pipe not ready")
			}
			return 0, last
		}
		wait := uint32(200)
		if remain < 200*time.Millisecond {
			wait = uint32(remain.Milliseconds())
			if wait == 0 {
				wait = 1
			}
		}
		_ = waitNamedPipe(name16, wait)
	}
}

func spawnTray() error {
	spawnMu.Lock()
	defer spawnMu.Unlock()
	if pipeReady(0) {
		return nil
	}
	if time.Since(lastSpawn) < spawnCooldown && !lastSpawn.IsZero() {
		return nil
	}

	exe, err := os.Executable()
	if err != nil {
		return err
	}
	cmdline := `"` + exe + `" tray`
	if cfg.StatusPort > 0 {
		cmdline += " --status-port " + strconv.Itoa(cfg.StatusPort)
	}
	if cfg.DataDir != "" {
		cmdline += ` --data-dir "` + cfg.DataDir + `"`
	}
	pi, err := winsession.LaunchInSession(exe, cmdline, nil, false, windows.CREATE_NO_WINDOW)
	if err != nil {
		return err
	}
	lastSpawn = time.Now()
	windows.CloseHandle(pi.Thread)
	windows.CloseHandle(pi.Process)
	return nil
}
