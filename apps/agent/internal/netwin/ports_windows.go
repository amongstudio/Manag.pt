//go:build windows

package netwin

import (
	"encoding/binary"
	"path/filepath"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	tcpTableOwnerPIDAll = 5
	udpTableOwnerPID    = 1
	mibTCPStateListen   = 2
	mibTCPStateEstab    = 5
)

var (
	modiphlpapi             = windows.NewLazySystemDLL("iphlpapi.dll")
	procGetExtendedTcpTable = modiphlpapi.NewProc("GetExtendedTcpTable")
	procGetExtendedUdpTable = modiphlpapi.NewProc("GetExtendedUdpTable")
)

type mibTCPRowOwnerPID struct {
	State      uint32
	LocalAddr  uint32
	LocalPort  uint32
	RemoteAddr uint32
	RemotePort uint32
	OwningPid  uint32
}

type mibTCP6RowOwnerPID struct {
	LocalAddr     [16]byte
	LocalScopeId  uint32
	LocalPort     uint32
	RemoteAddr    [16]byte
	RemoteScopeId uint32
	RemotePort    uint32
	State         uint32
	OwningPid     uint32
}

type mibUDPRowOwnerPID struct {
	LocalAddr uint32
	LocalPort uint32
	OwningPid uint32
}

type mibUDP6RowOwnerPID struct {
	LocalAddr    [16]byte
	LocalScopeId uint32
	LocalPort    uint32
	OwningPid    uint32
}

func Ports(req PortsRequest) (*PortList, error) {
	out := make([]Port, 0, 64)
	truncated := false
	names := map[uint32]string{}
	add := func(p Port) {
		if truncated {
			return
		}
		if req.ListenOnly && p.Protocol == "tcp" && p.State != "listen" {
			return
		}
		if len(out) >= maxPortRows {
			truncated = true
			return
		}
		if p.PID != 0 {
			if n, ok := names[p.PID]; ok {
				p.Process = n
			} else {
				n = queryProcessName(p.PID)
				names[p.PID] = n
				p.Process = n
			}
		}
		markOfficial(&p)
		out = append(out, p)
	}
	if err := collectTCP(windows.AF_INET, add); err != nil {
		return nil, err
	}
	_ = collectTCP(windows.AF_INET6, add)
	if err := collectUDP(windows.AF_INET, add); err != nil {
		return nil, err
	}
	_ = collectUDP(windows.AF_INET6, add)
	if out == nil {
		out = []Port{}
	}
	return &PortList{Ports: out, Truncated: truncated}, nil
}

func collectTCP(family uint32, add func(Port)) error {
	buf, err := getIPHelperTable(procGetExtendedTcpTable, family, tcpTableOwnerPIDAll)
	if err != nil || len(buf) < 4 {
		return err
	}
	n := binary.LittleEndian.Uint32(buf[:4])
	off := 4
	if family == windows.AF_INET6 {
		rowSize := int(unsafe.Sizeof(mibTCP6RowOwnerPID{}))
		for i := uint32(0); i < n; i++ {
			if off+rowSize > len(buf) {
				break
			}
			row := (*mibTCP6RowOwnerPID)(unsafe.Pointer(&buf[off]))
			off += rowSize
			localPort := nboPort(row.LocalPort)
			remotePort := nboPort(row.RemotePort)
			p := Port{
				Protocol:  "tcp",
				LocalAddr: ipv6String(row.LocalAddr),
				LocalPort: localPort,
				State:     tcpStateName(row.State),
				PID:       row.OwningPid,
			}
			if row.State != mibTCPStateListen {
				p.RemoteAddr = ipv6String(row.RemoteAddr)
				p.RemotePort = remotePort
			}
			add(p)
		}
		return nil
	}
	rowSize := int(unsafe.Sizeof(mibTCPRowOwnerPID{}))
	for i := uint32(0); i < n; i++ {
		if off+rowSize > len(buf) {
			break
		}
		row := (*mibTCPRowOwnerPID)(unsafe.Pointer(&buf[off]))
		off += rowSize
		p := Port{
			Protocol:  "tcp",
			LocalAddr: ipv4String(row.LocalAddr),
			LocalPort: nboPort(row.LocalPort),
			State:     tcpStateName(row.State),
			PID:       row.OwningPid,
		}
		if row.State != mibTCPStateListen {
			p.RemoteAddr = ipv4String(row.RemoteAddr)
			p.RemotePort = nboPort(row.RemotePort)
		}
		add(p)
	}
	return nil
}

func collectUDP(family uint32, add func(Port)) error {
	buf, err := getIPHelperTable(procGetExtendedUdpTable, family, udpTableOwnerPID)
	if err != nil || len(buf) < 4 {
		return err
	}
	n := binary.LittleEndian.Uint32(buf[:4])
	off := 4
	if family == windows.AF_INET6 {
		rowSize := int(unsafe.Sizeof(mibUDP6RowOwnerPID{}))
		for i := uint32(0); i < n; i++ {
			if off+rowSize > len(buf) {
				break
			}
			row := (*mibUDP6RowOwnerPID)(unsafe.Pointer(&buf[off]))
			off += rowSize
			add(Port{
				Protocol:  "udp",
				LocalAddr: ipv6String(row.LocalAddr),
				LocalPort: nboPort(row.LocalPort),
				State:     "open",
				PID:       row.OwningPid,
			})
		}
		return nil
	}
	rowSize := int(unsafe.Sizeof(mibUDPRowOwnerPID{}))
	for i := uint32(0); i < n; i++ {
		if off+rowSize > len(buf) {
			break
		}
		row := (*mibUDPRowOwnerPID)(unsafe.Pointer(&buf[off]))
		off += rowSize
		add(Port{
			Protocol:  "udp",
			LocalAddr: ipv4String(row.LocalAddr),
			LocalPort: nboPort(row.LocalPort),
			State:     "open",
			PID:       row.OwningPid,
		})
	}
	return nil
}

func getIPHelperTable(proc *windows.LazyProc, family, class uint32) ([]byte, error) {
	var size uint32
	r1, _, _ := proc.Call(0, uintptr(unsafe.Pointer(&size)), 1, uintptr(family), uintptr(class), 0)
	code := windows.Errno(r1)
	if r1 == 0 {
		return []byte{}, nil
	}
	if code == windows.ERROR_NOT_SUPPORTED {
		return nil, nil
	}
	if code != windows.ERROR_INSUFFICIENT_BUFFER {
		return nil, code
	}
	if size == 0 {
		return []byte{}, nil
	}
	buf := make([]byte, size)
	r1, _, _ = proc.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 1, uintptr(family), uintptr(class), 0)
	if r1 != 0 {
		return nil, windows.Errno(r1)
	}
	return buf, nil
}

func nboPort(v uint32) uint16 {
	p := uint16(v)
	return p<<8 | p>>8
}

func tcpStateName(s uint32) string {
	switch s {
	case 1:
		return "closed"
	case mibTCPStateListen:
		return "listen"
	case 3:
		return "syn_sent"
	case 4:
		return "syn_received"
	case mibTCPStateEstab:
		return "established"
	case 6:
		return "fin_wait1"
	case 7:
		return "fin_wait2"
	case 8:
		return "close_wait"
	case 9:
		return "closing"
	case 10:
		return "last_ack"
	case 11:
		return "time_wait"
	case 12:
		return "delete_tcb"
	default:
		return "unknown"
	}
}

func queryProcessName(pid uint32) string {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return ""
	}
	defer windows.CloseHandle(h)
	var buf [windows.MAX_PATH]uint16
	size := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &size); err != nil {
		return ""
	}
	return filepath.Base(windows.UTF16ToString(buf[:size]))
}
