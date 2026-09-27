//go:build windows

package netwin

import (
	"fmt"
	"net"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

const ipAdapterDHCPEnabled = 0x00000004

func Adapters() (*AdapterList, error) {
	flags := uint32(windows.GAA_FLAG_INCLUDE_PREFIX | windows.GAA_FLAG_INCLUDE_GATEWAYS | windows.GAA_FLAG_SKIP_ANYCAST | windows.GAA_FLAG_SKIP_MULTICAST)
	size := uint32(15_000)
	buf := make([]byte, size)
	err := windows.GetAdaptersAddresses(windows.AF_UNSPEC, flags, 0, (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0])), &size)
	if err == windows.ERROR_BUFFER_OVERFLOW {
		if size == 0 {
			return &AdapterList{Adapters: []Adapter{}}, nil
		}
		buf = make([]byte, size)
		err = windows.GetAdaptersAddresses(windows.AF_UNSPEC, flags, 0, (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0])), &size)
	}
	if err != nil {
		if err == windows.ERROR_NO_DATA || err == windows.ERROR_FILE_NOT_FOUND {
			return &AdapterList{Adapters: []Adapter{}}, nil
		}
		return nil, fmt.Errorf("%w: %v", ErrEnumFailed, err)
	}
	out := make([]Adapter, 0, 8)
	truncated := false
	for aa := (*windows.IpAdapterAddresses)(unsafe.Pointer(&buf[0])); aa != nil; aa = aa.Next {
		if len(out) >= maxAdapters {
			truncated = true
			break
		}
		out = append(out, adapterFrom(aa))
	}
	return &AdapterList{Adapters: out, Truncated: truncated}, nil
}

func adapterFrom(aa *windows.IpAdapterAddresses) Adapter {
	name := windows.UTF16PtrToString(aa.FriendlyName)
	if name == "" {
		name = windows.UTF16PtrToString(aa.Description)
	}
	if name == "" {
		name = windows.BytePtrToString(aa.AdapterName)
	}
	info := Adapter{
		Name:        name,
		Description: windows.UTF16PtrToString(aa.Description),
		ID:          windows.BytePtrToString(aa.AdapterName),
		Status:      operStatusName(aa.OperStatus),
		IfType:      ifTypeName(aa.IfType),
		MAC:         macString(aa.PhysicalAddress[:], aa.PhysicalAddressLength),
		MTU:         aa.Mtu,
		DHCP:        aa.Flags&ipAdapterDHCPEnabled != 0,
		DNSSuffix:   windows.UTF16PtrToString(aa.DnsSuffix),
		Index:       aa.IfIndex,
	}
	if ip := aa.Dhcpv4Server.IP(); ip != nil && !ip.IsUnspecified() {
		info.DHCP = true
		info.DHCPServer = ip.String()
	}
	for addr := aa.FirstUnicastAddress; addr != nil; addr = addr.Next {
		ip := addr.Address.IP()
		if ip == nil {
			continue
		}
		s := ip.String()
		if addr.OnLinkPrefixLength > 0 && addr.OnLinkPrefixLength <= 128 {
			s = fmt.Sprintf("%s/%d", s, addr.OnLinkPrefixLength)
		}
		if ip.To4() != nil {
			info.IPv4 = append(info.IPv4, s)
		} else {
			info.IPv6 = append(info.IPv6, s)
		}
	}
	for dns := aa.FirstDnsServerAddress; dns != nil; dns = dns.Next {
		if ip := dns.Address.IP(); ip != nil {
			info.DNS = append(info.DNS, ip.String())
		}
	}
	for gw := aa.FirstGatewayAddress; gw != nil; gw = gw.Next {
		if ip := gw.Address.IP(); ip != nil {
			info.Gateways = append(info.Gateways, ip.String())
		}
	}
	return info
}

func operStatusName(v uint32) string {
	switch v {
	case windows.IfOperStatusUp:
		return "up"
	case windows.IfOperStatusDown:
		return "down"
	case windows.IfOperStatusTesting:
		return "testing"
	case windows.IfOperStatusDormant:
		return "dormant"
	case windows.IfOperStatusNotPresent:
		return "not_present"
	case windows.IfOperStatusLowerLayerDown:
		return "lower_layer_down"
	default:
		return "unknown"
	}
}

func ifTypeName(v uint32) string {
	switch v {
	case windows.IF_TYPE_ETHERNET_CSMACD:
		return "ethernet"
	case windows.IF_TYPE_IEEE80211:
		return "wifi"
	case windows.IF_TYPE_SOFTWARE_LOOPBACK:
		return "loopback"
	case windows.IF_TYPE_PPP:
		return "ppp"
	case windows.IF_TYPE_TUNNEL:
		return "tunnel"
	case windows.IF_TYPE_ATM:
		return "atm"
	default:
		return "other"
	}
}

func macString(b []byte, n uint32) string {
	if n == 0 || int(n) > len(b) {
		return ""
	}
	parts := make([]string, n)
	for i := uint32(0); i < n; i++ {
		parts[i] = fmt.Sprintf("%02X", b[i])
	}
	return strings.Join(parts, "-")
}

func ipv4String(addr uint32) string {
	return net.IPv4(byte(addr), byte(addr>>8), byte(addr>>16), byte(addr>>24)).String()
}

func ipv6String(b [16]byte) string {
	return net.IP(b[:]).String()
}
