//go:build !windows

package smbwin

func Shares() (*ShareList, error) { return nil, ErrUnsupported }

func List(ListRequest, []Share) (*DirList, error) { return nil, ErrUnsupported }

func Connect(ConnectRequest) (*ConnectResult, error) { return nil, ErrUnsupported }

func Disconnect(string) (*ConnectResult, error) { return nil, ErrUnsupported }

func remoteDrive(string) bool { return false }

func mapOSError(err error) error { return err }
