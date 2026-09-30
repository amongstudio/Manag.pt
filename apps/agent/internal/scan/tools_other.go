//go:build !windows

package scan

import "os"

func machinePathDirs() []string {
	return []string{"/usr/local/bin", "/usr/bin", "/usr/local/sbin", "/usr/sbin", "/snap/bin"}
}

func knownToolDirs(string) []string { return nil }

// RawScanCapable reports whether nmap can open raw sockets (root).
func RawScanCapable() bool {
	return os.Geteuid() == 0
}
