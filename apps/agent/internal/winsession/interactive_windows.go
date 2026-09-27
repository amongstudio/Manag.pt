//go:build windows

package winsession

import (
	"runtime"

	"golang.org/x/sys/windows"
)

// RunInteractive impersonates the console user when the agent is in Session 0.
func RunInteractive(fn func() error) error {
	return runInteractive(fn, false)
}

// RunInteractiveUser impersonates the console user and does not fall back to
// the process token, so Session 0 never writes the SYSTEM credential store.
func RunInteractiveUser(fn func() error) error {
	return runInteractive(fn, true)
}

func runInteractive(fn func() error, strict bool) error {
	if fn == nil {
		return nil
	}
	if !InSession0() {
		return fn()
	}
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	tok, err := ImpersonationToken()
	if err != nil {
		if strict {
			return ErrNoInteractiveSession
		}
		return fn()
	}
	defer tok.Close()
	var imp windows.Token
	if err := windows.DuplicateTokenEx(tok, windows.TOKEN_QUERY|windows.TOKEN_IMPERSONATE|windows.TOKEN_DUPLICATE, nil, windows.SecurityImpersonation, windows.TokenImpersonation, &imp); err != nil {
		if strict {
			return ErrNoInteractiveSession
		}
		return fn()
	}
	defer imp.Close()
	if err := windows.SetThreadToken(nil, imp); err != nil {
		if strict {
			return ErrNoInteractiveSession
		}
		return fn()
	}
	defer windows.RevertToSelf()
	return fn()
}
