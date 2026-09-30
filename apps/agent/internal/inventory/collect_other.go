//go:build !windows

package inventory

import (
	"bufio"
	"os"
	"strings"
	"time"
)

func collectPlatform(rep *Report) {
	if text, err := runText(8*time.Second, "dpkg-query", "-W", "-f", "${Package}\t${Version}\n"); err == nil {
		for _, line := range strings.Split(text, "\n") {
			if len(rep.Software) >= 400 {
				break
			}
			parts := strings.Split(line, "\t")
			if len(parts) < 2 || strings.TrimSpace(parts[0]) == "" {
				continue
			}
			rep.Software = append(rep.Software, Software{Name: clip(parts[0], 256), Version: clip(parts[1], 128), Source: "dpkg"})
		}
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
	if text, err := runText(5*time.Second, "systemctl", "list-units", "--type=service", "--plain", "--no-legend", "--no-pager"); err == nil {
		for _, line := range strings.Split(text, "\n") {
			if len(rep.Services) >= 300 {
				break
			}
			fields := strings.Fields(line)
			if len(fields) < 4 {
				continue
			}
			rep.Services = append(rep.Services, Service{Name: strings.TrimSuffix(fields[0], ".service"), State: fields[3]})
		}
	}
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
