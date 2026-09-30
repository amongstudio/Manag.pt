package winops

import "testing"

func TestXPathFilters(t *testing.T) {
	got := xpathQuery(EventLogRequest{Level: "error", EventID: 1000, Source: "Disk", Since: "2026-01-01T00:00:00Z"})
	if !stringsContains(got, "EventID=1000") || !stringsContains(got, "Provider[@Name='Disk']") || !stringsContains(got, "TimeCreated") {
		t.Fatalf("%s", got)
	}
}

func TestParseEventLogFilters(t *testing.T) {
	req, err := ParseEventLog([]byte(`{"log":"Application","eventId":41,"source":"Kernel-Power","since":"2026-01-01T00:00:00Z"}`))
	if err != nil {
		t.Fatal(err)
	}
	if req.Log != "Application" || req.EventID != 41 || req.Source != "Kernel-Power" {
		t.Fatalf("%+v", req)
	}
}

func TestParseEventLogRejectsQuote(t *testing.T) {
	if _, err := ParseEventLog([]byte(`{"source":"a'b"}`)); err == nil {
		t.Fatal("expected error")
	}
}

func stringsContains(s, part string) bool {
	return len(s) >= len(part) && (s == part || len(part) == 0 || (len(s) > 0 && contains(s, part)))
}

func contains(s, part string) bool {
	for i := 0; i+len(part) <= len(s); i++ {
		if s[i:i+len(part)] == part {
			return true
		}
	}
	return false
}
