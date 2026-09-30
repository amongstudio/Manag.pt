package scan

import (
	"bytes"
	"context"
	"encoding/xml"
	"errors"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	cveID = regexp.MustCompile(`CVE-\d{4}-\d{4,7}`)
	cvssN = regexp.MustCompile(`([0-9]+(?:\.[0-9]+)?)`)
)

type Port struct {
	Protocol string `json:"protocol"`
	Port     int    `json:"port"`
	State    string `json:"state"`
	Service  string `json:"service,omitempty"`
	Product  string `json:"product,omitempty"`
	Version  string `json:"version,omitempty"`
	CVEs     []CVE  `json:"cves,omitempty"`
}

type CVE struct {
	ID     string  `json:"id"`
	CVSS   float64 `json:"cvss,omitempty"`
	Source string  `json:"source"`
}

type Host struct {
	IP       string `json:"ip"`
	Hostname string `json:"hostname,omitempty"`
	OS       string `json:"os,omitempty"`
	Ports    []Port `json:"ports"`
}

type NmapResult struct {
	Hosts []Host `json:"hosts"`
}

func ParseNmapXML(raw []byte) (NmapResult, error) {
	var doc nmapRun
	if err := xml.Unmarshal(raw, &doc); err != nil {
		return NmapResult{}, err
	}
	out := NmapResult{Hosts: []Host{}}
	for _, host := range doc.Hosts {
		item := Host{Ports: []Port{}}
		for _, addr := range host.Addresses {
			if addr.AddrType == "ipv4" || addr.AddrType == "ipv6" || item.IP == "" {
				item.IP = addr.Addr
				if addr.AddrType == "ipv4" {
					break
				}
			}
		}
		for _, name := range host.Hostnames.Names {
			if name.Name != "" {
				item.Hostname = name.Name
				break
			}
		}
		if len(host.OS.Matches) > 0 {
			item.OS = host.OS.Matches[0].Name
		}
		for _, port := range host.Ports.Ports {
			number, _ := strconv.Atoi(port.PortID)
			parsed := Port{
				Protocol: port.Protocol,
				Port:     number,
				State:    port.State.State,
				Service:  port.Service.Name,
				Product:  port.Service.Product,
				Version:  port.Service.Version,
			}
			for _, script := range port.Scripts {
				if script.ID != "vulners" {
					continue
				}
				parsed.CVEs = append(parsed.CVEs, cvesFrom(script)...)
			}
			item.Ports = append(item.Ports, parsed)
		}
		if item.IP != "" {
			out.Hosts = append(out.Hosts, item)
		}
	}
	return out, nil
}

func cvesFrom(script nmapScript) []CVE {
	seen := map[string]CVE{}
	add := func(id string, cvss float64, explicit bool) {
		id = strings.ToUpper(strings.TrimSpace(id))
		if !cveID.MatchString(id) {
			return
		}
		prev, ok := seen[id]
		if !ok {
			seen[id] = CVE{ID: id, CVSS: cvss, Source: "vulners"}
			return
		}
		if explicit || (prev.CVSS == 0 && cvss > 0) {
			prev.CVSS = cvss
			seen[id] = prev
		}
	}
	for _, id := range cveID.FindAllString(script.Output, -1) {
		add(id, 0, false)
	}
	for _, table := range script.Tables {
		var id string
		var cvss float64
		for _, elem := range table.Elems {
			if strings.EqualFold(elem.Key, "id") {
				id = elem.Value
			}
			if strings.EqualFold(elem.Key, "cvss") {
				if n, err := strconv.ParseFloat(strings.TrimSpace(elem.Value), 64); err == nil {
					cvss = n
				}
			}
		}
		add(id, cvss, cvss > 0)
	}
	for id, item := range seen {
		if item.CVSS == 0 {
			if match := cvssN.FindStringSubmatch(script.Output); len(match) == 2 && strings.Contains(script.Output, id) {
				if n, err := strconv.ParseFloat(match[1], 64); err == nil && n <= 10 {
					item.CVSS = n
					seen[id] = item
				}
			}
		}
	}
	out := make([]CVE, 0, len(seen))
	for _, item := range seen {
		out = append(out, item)
	}
	return out
}

func NmapAvailable() bool {
	_, err := exec.LookPath("nmap")
	return err == nil
}

func RunNmap(ctx context.Context, target string, maxRate int, timeout time.Duration, vulners bool) (NmapResult, error) {
	if !NmapAvailable() {
		return NmapResult{}, errors.New("nmap_unavailable")
	}
	if maxRate <= 0 {
		maxRate = 100
	}
	args := []string{"-sV", "-O", "-oX", "-", "--max-rate", strconvItoa(maxRate)}
	if vulners {
		args = append(args, "--script", "vulners")
	}
	args = append(args, target)
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	runCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(runCtx, "nmap", args...)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	if stdout.Len() == 0 {
		if err != nil {
			return NmapResult{}, err
		}
		return NmapResult{}, errors.New("nmap_empty")
	}
	parsed, parseErr := ParseNmapXML(stdout.Bytes())
	if parseErr != nil {
		return NmapResult{}, parseErr
	}
	return parsed, nil
}

func strconvItoa(n int) string {
	return strconv.Itoa(n)
}

type nmapRun struct {
	XMLName xml.Name   `xml:"nmaprun"`
	Hosts   []nmapHost `xml:"host"`
}

type nmapHost struct {
	Addresses []struct {
		Addr     string `xml:"addr,attr"`
		AddrType string `xml:"addrtype,attr"`
	} `xml:"address"`
	Hostnames struct {
		Names []struct {
			Name string `xml:"name,attr"`
		} `xml:"hostname"`
	} `xml:"hostnames"`
	Ports struct {
		Ports []nmapPort `xml:"port"`
	} `xml:"ports"`
	OS struct {
		Matches []struct {
			Name string `xml:"name,attr"`
		} `xml:"osmatch"`
	} `xml:"os"`
}

type nmapPort struct {
	Protocol string `xml:"protocol,attr"`
	PortID   string `xml:"portid,attr"`
	State    struct {
		State string `xml:"state,attr"`
	} `xml:"state"`
	Service struct {
		Name    string `xml:"name,attr"`
		Product string `xml:"product,attr"`
		Version string `xml:"version,attr"`
	} `xml:"service"`
	Scripts []nmapScript `xml:"script"`
}

type nmapScript struct {
	ID     string      `xml:"id,attr"`
	Output string      `xml:"output,attr"`
	Tables []nmapTable `xml:"table"`
}

type nmapTable struct {
	Elems []nmapElem `xml:"elem"`
}

type nmapElem struct {
	Key   string `xml:"key,attr"`
	Value string `xml:",chardata"`
}
