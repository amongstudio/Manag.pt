package inventory

import (
	"strings"
	"testing"
)

func TestParseDpkgAndRedact(t *testing.T) {
	rows := ParseDpkg("curl\t8.5.0\tDebian Curl Maintainers\n\nbad\n")
	if len(rows) != 1 || rows[0].Name != "curl" || rows[0].Source != "dpkg" || rows[0].Publisher == "" {
		t.Fatalf("%+v", rows)
	}
	if got := RedactConfig("ExecStart=/usr/bin/app password=hunter2"); strings.Contains(got, "hunter2") {
		t.Fatal(got)
	}
	if CleanSerial("To be filled by O.E.M.") != "" || CleanSerial("ABC123") != "ABC123" {
		t.Fatal("serial filter")
	}
}

func TestParseSystemdListenAndRoute(t *testing.T) {
	text := "Id=ssh.service\nDescription=OpenSSH\nActiveState=active\nUnitFileState=enabled\nUser=\nFragmentPath=/lib/systemd/system/ssh.service\nDropInPaths=/etc/systemd/system/ssh.service.d/local.conf\nExecStart={ path=/usr/sbin/sshd ; argv[]=/usr/sbin/sshd -D password=nope ; }\n\nId=cron.service\nDescription=cron\nActiveState=inactive\nUnitFileState=disabled\n"
	services := ParseSystemdShow(text)
	if len(services) != 2 || services[0].Name != "ssh" || services[0].StartType != "enabled" || services[0].BinaryPath != "/usr/sbin/sshd" {
		t.Fatalf("%+v", services[0])
	}
	if strings.Contains(services[0].BinaryPath, "nope") {
		t.Fatal(services[0].BinaryPath)
	}
	listens := ParseListen("LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:((\"sshd\",pid=9,fd=3))\n")
	AttachListenPorts(services, listens)
	if services[0].ListenPorts != "22" {
		t.Fatalf("ports %q", services[0].ListenPorts)
	}
	if got := ParseRoute("eth0 00000000 0101A8C0 0003 0 0 0 0 0 0 0\n"); got != "192.168.1.1" {
		t.Fatalf("gateway %s", got)
	}
	domain, dns := ParseResolv("nameserver 1.1.1.1\nsearch example.test\n")
	if domain != "example.test" || len(dns) != 1 {
		t.Fatalf("%s %v", domain, dns)
	}
}

func TestParseMemoryLsblkAndWindowsUninstallShape(t *testing.T) {
	memory := ParseDMIMemory("Memory Device\n\tSize: 8192 MB\n\tLocator: DIMM_A\n\tSpeed: 3200 MT/s\n\tManufacturer: Samsung\n\tSerial Number: To be filled by O.E.M.\n\nMemory Device\n\tSize: No Module Installed\n")
	if len(memory) != 1 || memory[0].Bank != "DIMM_A" || memory[0].SpeedMhz != 3200 || memory[0].Serial != "" || memory[0].SizeBytes == 0 {
		t.Fatalf("%+v", memory)
	}
	disks := ParseLsblk(`{"blockdevices":[{"name":"sda","type":"disk","size":1000,"model":"QEMU","serial":"none"},{"name":"sda1","type":"part","size":100}]}`)
	if len(disks) != 1 || disks[0].Name != "sda" || disks[0].Serial != "" {
		t.Fatalf("%+v", disks)
	}
	name, version := ParseOsRelease("NAME=\"Debian\"\nVERSION_ID=\"12\"\nPRETTY_NAME=\"Debian GNU/Linux 12\"\n")
	if !strings.Contains(name, "Debian") || version != "12" {
		t.Fatalf("%s %s", name, version)
	}
}

func TestLiveCollectReadsThisHost(t *testing.T) {
	rep := Collect()
	if rep.OS.Hostname == "" || rep.OS.Arch == "" {
		t.Fatalf("os %+v", rep.OS)
	}
	if len(rep.CPUs) == 0 || rep.CPUs[0].Threads < rep.CPUs[0].Cores {
		t.Fatalf("cpu %+v", rep.CPUs)
	}
	if len(rep.Volumes) == 0 {
		t.Fatal("expected at least one volume")
	}
	foundPkg := false
	for _, item := range rep.Software {
		if item.Source == "dpkg" && item.Name != "" {
			foundPkg = true
			break
		}
	}
	if !foundPkg {
		t.Fatal("expected dpkg packages from this host")
	}
}
