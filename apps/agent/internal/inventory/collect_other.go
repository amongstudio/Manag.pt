//go:build !windows

package inventory

import (
	"bufio"
	"os"
	"strings"
	"time"
)

func collectPlatform(rep *Report) {
	if raw, err := os.ReadFile("/etc/os-release"); err == nil {
		name, version := ParseOsRelease(string(raw))
		if name != "" {
			rep.OS.Name = name
		}
		if version != "" {
			rep.OS.Version = version
		}
	}
	if raw, err := os.ReadFile("/sys/class/dmi/id/sys_vendor"); err == nil {
		rep.Hardware.Manufacturer = clip(string(raw), 128)
	}
	if raw, err := os.ReadFile("/sys/class/dmi/id/product_name"); err == nil {
		rep.Hardware.Model = clip(string(raw), 128)
	}
	if raw, err := os.ReadFile("/sys/class/dmi/id/product_serial"); err == nil {
		rep.Hardware.Serial = CleanSerial(string(raw))
	}
	if raw, err := os.ReadFile("/sys/class/dmi/id/chassis_type"); err == nil {
		rep.Hardware.Chassis = clip(string(raw), 32)
	}
	if raw, err := os.ReadFile("/sys/class/dmi/id/bios_vendor"); err == nil {
		rep.Hardware.BiosVendor = clip(string(raw), 128)
	}
	if raw, err := os.ReadFile("/sys/class/dmi/id/bios_version"); err == nil {
		rep.Hardware.BiosVersion = clip(string(raw), 128)
	}
	if text, err := runText(4*time.Second, "hostname", "-f"); err == nil {
		if fqdn := clip(text, 256); fqdn != "" {
			rep.OS.FQDN = fqdn
		}
	}
	if raw, err := os.ReadFile("/etc/resolv.conf"); err == nil {
		domain, dns := ParseResolv(string(raw))
		rep.OS.Domain = domain
		rep.OS.DNSServers = strings.Join(dns, ",")
	}
	if raw, err := os.ReadFile("/proc/net/route"); err == nil {
		rep.OS.Gateway = ParseRoute(string(raw))
	}
	if text, err := runText(4*time.Second, "dmidecode", "-t", "memory"); err == nil {
		rep.Memory = append(rep.Memory, ParseDMIMemory(text)...)
	}
	if text, err := runText(4*time.Second, "lsblk", "-J", "-b", "-o", "NAME,TYPE,SIZE,MODEL,SERIAL"); err == nil {
		if disks := ParseLsblk(text); len(disks) > 0 {
			rep.Disks = disks
		}
	}
	if text, err := runText(8*time.Second, "dpkg-query", "-W", "-f", "${Package}\t${Version}\t${Maintainer}\n"); err == nil {
		rep.Software = append(rep.Software, ParseDpkg(text)...)
	}
	if text, err := runText(8*time.Second, "brew", "list", "--versions"); err == nil {
		rep.Software = append(rep.Software, ParseBrew(text)...)
	}
	if text, err := runText(3*time.Second, "lpstat", "-p"); err == nil {
		for _, line := range strings.Split(text, "\n") {
			if len(rep.Printers) >= 50 || !strings.HasPrefix(line, "printer ") {
				continue
			}
			fields := strings.Fields(line)
			if len(fields) > 1 {
				rep.Printers = append(rep.Printers, Printer{Name: fields[1]})
			}
		}
	}
	if text, err := runText(3*time.Second, "lspci", "-nn"); err == nil {
		for _, line := range strings.Split(text, "\n") {
			if len(rep.GPUs) >= 8 {
				break
			}
			lower := strings.ToLower(line)
			if strings.Contains(lower, "vga") || strings.Contains(lower, "3d controller") {
				rep.GPUs = append(rep.GPUs, GPU{Name: clip(line, 256)})
			}
		}
	}
	collectPasswd(rep)
	collectUSB(rep)
	for _, candidate := range []struct{ name, path string }{
		{"firefox", "/usr/bin/firefox"},
		{"chromium", "/usr/bin/chromium"},
		{"chromium", "/usr/bin/chromium-browser"},
		{"google-chrome", "/usr/bin/google-chrome"},
	} {
		if fileExists(candidate.path) {
			rep.Browsers = append(rep.Browsers, Browser{Name: candidate.name, Path: candidate.path})
		}
	}
	if text, err := runText(8*time.Second, "systemctl", "show", "--type=service", "--no-pager", "-p", "Id", "-p", "Description", "-p", "ActiveState", "-p", "UnitFileState", "-p", "User", "-p", "FragmentPath", "-p", "DropInPaths", "-p", "ExecStart"); err == nil {
		rep.Services = ParseSystemdShow(text)
	}
	if text, err := runText(4*time.Second, "ss", "-lntp"); err == nil {
		listens := ParseListen(text)
		AttachListenPorts(rep.Services, listens)
		ports := []string{}
		for _, values := range listens {
			ports = append(ports, values...)
		}
		rep.OS.Roles = RolesFromPorts(strings.Join(ports, ","))
	}
	ips := []string{}
	for _, adapter := range rep.Adapters {
		for _, ip := range adapter.IPs {
			if strings.HasPrefix(ip, "127.") || strings.HasPrefix(ip, "::1") || ip == "" {
				continue
			}
			ips = append(ips, ip)
			if len(ips) >= 8 {
				break
			}
		}
	}
	rep.OS.PrimaryIPs = strings.Join(ips, ",")
}

func collectPasswd(rep *Report) {
	file, err := os.Open("/etc/passwd")
	if err != nil {
		return
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		if len(rep.Users) >= 200 {
			break
		}
		parts := strings.Split(scanner.Text(), ":")
		if len(parts) < 7 {
			continue
		}
		shell := parts[6]
		if strings.Contains(shell, "nologin") || strings.Contains(shell, "false") {
			continue
		}
		rep.Users = append(rep.Users, User{Name: parts[0], SID: parts[2], Local: true})
	}
}

func collectUSB(rep *Report) {
	entries, err := os.ReadDir("/sys/bus/usb/devices")
	if err != nil {
		return
	}
	for _, entry := range entries {
		if len(rep.USB) >= 100 || strings.Contains(entry.Name(), ":") {
			continue
		}
		base := "/sys/bus/usb/devices/" + entry.Name()
		product, _ := os.ReadFile(base + "/product")
		vendor, _ := os.ReadFile(base + "/idVendor")
		idProduct, _ := os.ReadFile(base + "/idProduct")
		if len(product) == 0 && len(vendor) == 0 {
			continue
		}
		rep.USB = append(rep.USB, USB{Name: clip(string(product), 128), VendorID: clip(string(vendor), 8), ProductID: clip(string(idProduct), 8)})
	}
}
