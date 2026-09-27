//go:build windows

package smbwin

import (
	"errors"
	"os"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/pc-manager/agent/internal/winsession"
	"golang.org/x/sys/windows"
)

const (
	shareTypeDisk        = 0
	useLevel2            = 2
	resourceTypeDisk     = 1
	connectUpdateProfile = 0x00000001
	connectTemporary     = 0x00000004
	connectInteractive   = 0x00000008
	shareTypeMask        = 0x000000FF
	maxPreferred         = 0xFFFFFFFF
)

type shareInfo1 struct {
	NetName *uint16
	Type    uint32
	_       uint32
	Remark  *uint16
}

type useInfo2 struct {
	Local      *uint16
	Remote     *uint16
	Password   *uint16
	Status     uint32
	AsgType    uint32
	RefCount   uint32
	UseCount   uint32
	Username   *uint16
	DomainName *uint16
}

type netResource struct {
	Scope       uint32
	Type        uint32
	DisplayType uint32
	Usage       uint32
	LocalName   *uint16
	RemoteName  *uint16
	Comment     *uint16
	Provider    *uint16
}

var (
	modNetapi32          = windows.NewLazySystemDLL("netapi32.dll")
	modMpr               = windows.NewLazySystemDLL("mpr.dll")
	procNetShareEnum     = modNetapi32.NewProc("NetShareEnum")
	procNetUseEnum       = modNetapi32.NewProc("NetUseEnum")
	procNetApiBufferFree = modNetapi32.NewProc("NetApiBufferFree")
	procWNetAdd          = modMpr.NewProc("WNetAddConnection2W")
	procWNetCancel       = modMpr.NewProc("WNetCancelConnection2W")
)

func Shares() (*ShareList, error) {
	out := &ShareList{Shares: []Share{}}
	seen := map[string]bool{}
	add := func(s Share) {
		key := strings.ToLower(s.Path + "|" + s.Drive + "|" + s.Remote)
		if seen[key] {
			return
		}
		seen[key] = true
		if len(out.Shares) >= maxShares {
			out.Truncated = true
			return
		}
		out.Shares = append(out.Shares, s)
	}
	for _, s := range hostedShares() {
		add(s)
	}
	_ = winsession.RunInteractiveUser(func() error {
		for _, s := range mappedDrives() {
			add(s)
		}
		for _, s := range useEnumShares() {
			add(s)
		}
		return nil
	})
	return out, nil
}

func hostedShares() []Share {
	var buf *byte
	var read, total uint32
	r, _, _ := procNetShareEnum.Call(0, 1, uintptr(unsafe.Pointer(&buf)), uintptr(maxPreferred), uintptr(unsafe.Pointer(&read)), uintptr(unsafe.Pointer(&total)), 0)
	if r != 0 || buf == nil {
		return nil
	}
	defer procNetApiBufferFree.Call(uintptr(unsafe.Pointer(buf)))
	rows := unsafe.Slice((*shareInfo1)(unsafe.Pointer(buf)), int(read))
	host, _ := os.Hostname()
	out := make([]Share, 0, len(rows))
	for _, row := range rows {
		name := windows.UTF16PtrToString(row.NetName)
		if name == "" || row.Type&shareTypeMask != shareTypeDisk {
			continue
		}
		unc := `\\` + host + `\` + name
		out = append(out, Share{
			Name:      name,
			Path:      unc,
			Kind:      "hosted",
			Remark:    windows.UTF16PtrToString(row.Remark),
			Remote:    unc,
			Connected: true,
			Hosted:    true,
		})
	}
	return out
}

func mappedDrives() []Share {
	bits, err := windows.GetLogicalDrives()
	if err != nil {
		return nil
	}
	var out []Share
	for i := 0; i < 26; i++ {
		if bits&(1<<uint(i)) == 0 {
			continue
		}
		root := string(rune('A'+i)) + `:\`
		kind := windows.GetDriveType(windows.StringToUTF16Ptr(root))
		if kind != windows.DRIVE_REMOTE {
			continue
		}
		remote := queryDosDevice(string(rune('A'+i)) + ":")
		out = append(out, Share{
			Name:      string(rune('A'+i)) + ":",
			Path:      root,
			Kind:      "mapped",
			Drive:     string(rune('A'+i)) + ":",
			Remote:    remote,
			Connected: true,
			Status:    "mapped",
		})
	}
	return out
}

func queryDosDevice(drive string) string {
	buf := make([]uint16, 512)
	n, err := windows.QueryDosDevice(windows.StringToUTF16Ptr(drive), &buf[0], uint32(len(buf)))
	if err != nil || n == 0 {
		return ""
	}
	s := windows.UTF16ToString(buf)
	return DosDeviceToUNC(s)
}

func useEnumShares() []Share {
	var buf *byte
	var read, total uint32
	r, _, _ := procNetUseEnum.Call(0, useLevel2, uintptr(unsafe.Pointer(&buf)), uintptr(maxPreferred), uintptr(unsafe.Pointer(&read)), uintptr(unsafe.Pointer(&total)), 0)
	if r != 0 || buf == nil {
		return nil
	}
	defer procNetApiBufferFree.Call(uintptr(unsafe.Pointer(buf)))
	rows := unsafe.Slice((*useInfo2)(unsafe.Pointer(buf)), int(read))
	out := make([]Share, 0, len(rows))
	for _, row := range rows {
		remote := windows.UTF16PtrToString(row.Remote)
		local := windows.UTF16PtrToString(row.Local)
		if remote == "" {
			continue
		}
		out = append(out, Share{
			Name:      local,
			Path:      firstNonEmpty(local, remote),
			Kind:      "session",
			Drive:     local,
			Remote:    remote,
			Connected: row.Status == 0,
			Username:  joinUser(windows.UTF16PtrToString(row.DomainName), windows.UTF16PtrToString(row.Username)),
			Status:    useStatus(row.Status),
		})
	}
	return out
}

func firstNonEmpty(v ...string) string {
	for _, s := range v {
		if strings.TrimSpace(s) != "" {
			return s
		}
	}
	return ""
}

func joinUser(domain, user string) string {
	user = strings.TrimSpace(user)
	domain = strings.TrimSpace(domain)
	if user == "" {
		return ""
	}
	if domain == "" {
		return user
	}
	return domain + `\` + user
}

func useStatus(v uint32) string {
	switch v {
	case 0:
		return "ok"
	case 1:
		return "paused"
	case 2:
		return "disconnected"
	case 3:
		return "network_error"
	case 4:
		return "connecting"
	case 5:
		return "reconnecting"
	default:
		return "unknown"
	}
}

func List(req ListRequest, known []Share) (*DirList, error) {
	if !PathAllowed(req.Path, known) {
		return nil, ErrNotConnected
	}
	var result *DirList
	var listErr error
	run := func() error {
		entries, err := os.ReadDir(req.Path)
		if err != nil {
			listErr = mapSmbErr(err)
			return listErr
		}
		out := &DirList{Path: req.Path, Entries: []Entry{}}
		for _, e := range entries {
			if len(out.Entries) >= maxList {
				out.Truncated = true
				break
			}
			info, _ := e.Info()
			row := Entry{Name: e.Name(), Path: JoinSharePath(req.Path, e.Name()), Dir: e.IsDir()}
			if info != nil {
				row.Size = info.Size()
				row.Mode = info.Mode().String()
				row.Mtime = info.ModTime().UTC().Format(time.RFC3339)
			}
			out.Entries = append(out.Entries, row)
		}
		result = out
		return nil
	}
	if err := winsession.RunInteractiveUser(run); err != nil && listErr == nil {
		listErr = err
	}
	if result != nil {
		return result, nil
	}
	if listErr == nil {
		listErr = ErrNotFound
	}
	return nil, listErr
}

func Connect(req ConnectRequest) (*ConnectResult, error) {
	var nr netResource
	remote, err := syscall.UTF16PtrFromString(req.UNC)
	if err != nil {
		return nil, err
	}
	nr.Type = resourceTypeDisk
	nr.RemoteName = remote
	if req.Drive != "" {
		local, err := syscall.UTF16PtrFromString(req.Drive + ":")
		if err != nil {
			return nil, err
		}
		nr.LocalName = local
	}
	var user, pass *uint16
	if req.Username != "" {
		user, _ = syscall.UTF16PtrFromString(req.Username)
	}
	if req.Password != "" {
		pass, _ = syscall.UTF16PtrFromString(req.Password)
	}
	flags := uint32(0)
	if req.Persist {
		flags |= connectUpdateProfile
	} else {
		flags |= connectTemporary
	}
	if req.Username == "" {
		flags |= connectInteractive
	}
	err = winsession.RunInteractiveUser(func() error {
		r, _, e := procWNetAdd.Call(uintptr(unsafe.Pointer(&nr)), uintptr(unsafe.Pointer(pass)), uintptr(unsafe.Pointer(user)), uintptr(flags))
		if r != 0 {
			return mapSmbCode(uint32(r), e)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	drive := req.Drive
	if drive != "" {
		drive += ":"
	}
	return &ConnectResult{UNC: req.UNC, Connected: true, Drive: drive, Action: "connect"}, nil
}

func Disconnect(target string) (*ConnectResult, error) {
	name, err := syscall.UTF16PtrFromString(target)
	if err != nil {
		return nil, err
	}
	err = winsession.RunInteractiveUser(func() error {
		r, _, e := procWNetCancel.Call(uintptr(unsafe.Pointer(name)), 0, 0)
		if r != 0 {
			return mapSmbCode(uint32(r), e)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &ConnectResult{UNC: target, Connected: false, Action: "disconnect"}, nil
}

func remoteDrive(p string) bool {
	clean, err := NormalizeSharePath(p)
	if err != nil || !IsDrivePath(clean) {
		return false
	}
	root := strings.ToUpper(clean[:1]) + `:\`
	kind := windows.GetDriveType(windows.StringToUTF16Ptr(root))
	return kind == windows.DRIVE_REMOTE
}

func mapOSError(err error) error {
	return mapSmbErr(err)
}

func mapSmbErr(err error) error {
	if err == nil {
		return nil
	}
	if os.IsPermission(err) {
		return ErrAccessDenied
	}
	if os.IsNotExist(err) {
		return ErrNotFound
	}
	var pathErr *os.PathError
	if errors.As(err, &pathErr) && pathErr.Err != nil {
		if mapped := mapSmbErrno(pathErr.Err); mapped != nil {
			return mapped
		}
	}
	if mapped := mapSmbErrno(err); mapped != nil {
		return mapped
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "access") || strings.Contains(msg, "denied") || strings.Contains(msg, "logon") || strings.Contains(msg, "credential") {
		return ErrAccessDenied
	}
	return err
}

func mapSmbErrno(err error) error {
	var errno windows.Errno
	if !errors.As(err, &errno) {
		return nil
	}
	switch uint32(errno) {
	case 5, 32, 86, 1219, 1326, 1909, 2202, 0x80070005:
		return ErrAccessDenied
	case 2, 3, 53, 67, 1203, 2250:
		return ErrNotFound
	default:
		return nil
	}
}

func mapSmbCode(code uint32, err error) error {
	switch code {
	case 5, 86, 1219, 1326, 2202, 0x80070005:
		return ErrAccessDenied
	case 2, 3, 53, 67, 1203, 2250:
		return ErrNotFound
	case 85, 87:
		return ErrInvalidPayload
	case 0:
		return nil
	}
	if err != nil {
		return err
	}
	return ErrNotConnected
}
