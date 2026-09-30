//go:build windows

package localusers

import (
	"errors"
	"os"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

var (
	netapi32           = windows.NewLazySystemDLL("netapi32.dll")
	procNetUserEnum    = netapi32.NewProc("NetUserEnum")
	procNetUserSetInfo = netapi32.NewProc("NetUserSetInfo")
)

const (
	filterNormalAccount      = 0x0002
	maxPreferredLength       = 0xFFFFFFFF
	errorMoreData            = 234
	nerrUserNotFound         = 2221
	nerrPasswordTooShort     = 2245
	nerrPasswordHistConflict = 2244
	nerrLastAdmin            = 2452

	ufAccountDisable   = 0x0002
	ufLockout          = 0x0010
	ufPasswdNotReqd    = 0x0020
	ufPasswdCantChange = 0x0040
	ufDontExpirePasswd = 0x10000
	ufPasswordExpired  = 0x800000

	userPrivGuest = 0
	userPrivUser  = 1
	userPrivAdmin = 2

	timeqForever = 0xFFFFFFFF
)

type userInfo2 struct {
	Name         *uint16
	Password     *uint16
	PasswordAge  uint32
	Priv         uint32
	HomeDir      *uint16
	Comment      *uint16
	Flags        uint32
	ScriptPath   *uint16
	AuthFlags    uint32
	FullName     *uint16
	UsrComment   *uint16
	Parms        *uint16
	Workstations *uint16
	LastLogon    uint32
	LastLogoff   uint32
	AcctExpires  uint32
	MaxStorage   uint32
	UnitsPerWeek uint32
	LogonHours   *byte
	BadPwCount   uint32
	NumLogons    uint32
	LogonServer  *uint16
	CountryCode  uint32
	CodePage     uint32
}

type userInfo1003 struct {
	Password *uint16
}

type userInfo1008 struct {
	Flags uint32
}

func epoch(sec uint32) string {
	if sec == 0 || sec == timeqForever {
		return ""
	}
	return time.Unix(int64(sec), 0).UTC().Format(time.RFC3339)
}

func privName(p uint32) string {
	switch p {
	case userPrivAdmin:
		return "admin"
	case userPrivGuest:
		return "guest"
	default:
		return "user"
	}
}

func toUser(info *userInfo2) User {
	name := windows.UTF16PtrToString(info.Name)
	u := User{
		Name:              name,
		FullName:          windows.UTF16PtrToString(info.FullName),
		Comment:           windows.UTF16PtrToString(info.Comment),
		Enabled:           info.Flags&ufAccountDisable == 0,
		LockedOut:         info.Flags&ufLockout != 0,
		Admin:             info.Priv == userPrivAdmin,
		Privilege:         privName(info.Priv),
		PasswordRequired:  info.Flags&ufPasswdNotReqd == 0,
		PasswordCanChange: info.Flags&ufPasswdCantChange == 0,
		PasswordExpires:   info.Flags&ufDontExpirePasswd == 0,
		PasswordExpired:   info.Flags&ufPasswordExpired != 0,
		PasswordAgeDays:   int(info.PasswordAge / 86400),
		LastLogon:         epoch(info.LastLogon),
		AccountExpires:    epoch(info.AcctExpires),
		BadPasswordCount:  int(info.BadPwCount),
		LogonCount:        int(info.NumLogons),
	}
	if host, err := os.Hostname(); err == nil {
		if sid, _, _, err := windows.LookupSID("", host+`\`+name); err == nil {
			u.SID = sid.String()
		}
	}
	return u
}

func List() (*Result, error) {
	res := &Result{Users: []User{}}
	res.Computer, _ = os.Hostname()
	var resume uint32
	for {
		var buf *byte
		var read, total uint32
		r, _, _ := procNetUserEnum.Call(0, 2, filterNormalAccount,
			uintptr(unsafe.Pointer(&buf)), maxPreferredLength,
			uintptr(unsafe.Pointer(&read)), uintptr(unsafe.Pointer(&total)), uintptr(unsafe.Pointer(&resume)))
		if r != 0 && r != errorMoreData {
			return nil, netErr("net_user_enum", r)
		}
		if buf != nil {
			entries := unsafe.Slice((*userInfo2)(unsafe.Pointer(buf)), read)
			for i := range entries {
				if len(res.Users) >= maxUsers {
					res.Truncated = true
					break
				}
				res.Users = append(res.Users, toUser(&entries[i]))
			}
			_ = windows.NetApiBufferFree(buf)
		}
		if r != errorMoreData || res.Truncated {
			break
		}
	}
	return res, nil
}

func getInfo2(name string) (User, uint32, error) {
	p, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return User{}, 0, errors.New("invalid_username")
	}
	var buf *byte
	if err := windows.NetUserGetInfo(nil, p, 2, &buf); err != nil {
		if errno, ok := err.(syscall.Errno); ok && errno == nerrUserNotFound {
			return User{}, 0, errors.New("user_not_found")
		}
		return User{}, 0, err
	}
	defer windows.NetApiBufferFree(buf)
	info := (*userInfo2)(unsafe.Pointer(buf))
	return toUser(info), info.Flags, nil
}

func isDomainController() bool {
	k, err := registry.OpenKey(registry.LOCAL_MACHINE, `SYSTEM\CurrentControlSet\Control\ProductOptions`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	v, _, _ := k.GetStringValue("ProductType")
	return strings.EqualFold(v, "LanmanNT")
}

func enabledAdmins() int {
	res, err := List()
	if err != nil {
		return -1
	}
	n := 0
	for _, u := range res.Users {
		if u.Admin && u.Enabled {
			n++
		}
	}
	return n
}

func setInfo(name string, level uint32, data unsafe.Pointer) error {
	p, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return errors.New("invalid_username")
	}
	var parmErr uint32
	r, _, _ := procNetUserSetInfo.Call(0, uintptr(unsafe.Pointer(p)), uintptr(level), uintptr(data), uintptr(unsafe.Pointer(&parmErr)))
	if r != 0 {
		return netErr("net_user_set_info", r)
	}
	return nil
}

func netErr(op string, code uintptr) error {
	switch code {
	case nerrUserNotFound:
		return errors.New("user_not_found")
	case nerrPasswordTooShort, nerrPasswordHistConflict:
		return errors.New("password_policy")
	case nerrLastAdmin:
		return errors.New("last_enabled_admin")
	case uintptr(windows.ERROR_ACCESS_DENIED):
		return errors.New("access_denied")
	}
	return errors.New(op + ": " + syscall.Errno(code).Error())
}

// Apply enables, disables, or sets the password of an existing local
// account. Domain controllers are refused because their "local" accounts
// are domain accounts.
func Apply(req ActionRequest) (map[string]any, error) {
	if isDomainController() {
		return nil, errors.New("domain_controller_refused")
	}
	user, flags, err := getInfo2(req.Username)
	if err != nil {
		return nil, err
	}
	out := map[string]any{"username": user.Name, "action": req.Action}
	switch req.Action {
	case "enable":
		if err := setInfo(user.Name, 1008, unsafe.Pointer(&userInfo1008{Flags: flags &^ ufAccountDisable})); err != nil {
			return out, err
		}
	case "disable":
		if user.Admin && user.Enabled && enabledAdmins() <= 1 {
			return out, errors.New("last_enabled_admin")
		}
		if err := setInfo(user.Name, 1008, unsafe.Pointer(&userInfo1008{Flags: flags | ufAccountDisable})); err != nil {
			return out, err
		}
	case "set_password":
		pw, err := windows.UTF16FromString(req.Password)
		if err != nil {
			return out, errors.New("invalid_password")
		}
		err = setInfo(user.Name, 1003, unsafe.Pointer(&userInfo1003{Password: &pw[0]}))
		for i := range pw {
			pw[i] = 0
		}
		if err != nil {
			return out, err
		}
	default:
		return out, errors.New("invalid_action")
	}
	if after, _, err := getInfo2(user.Name); err == nil {
		out["user"] = after
	}
	out["ok"] = true
	return out, nil
}
