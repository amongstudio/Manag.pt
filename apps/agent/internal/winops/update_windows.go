//go:build windows

package winops

import (
	"errors"
	"runtime"
	"strings"
	"time"

	ole "github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

const (
	rpcEChangedMode = 0x80010106
	sFalse          = 0x00000001
)

func WindowsUpdate(req UpdateRequest) (*UpdateResult, error) {
	var result *UpdateResult
	err := withWUAPI(func(searcher *ole.IDispatch) error {
		if _, err := oleutil.PutProperty(searcher, "Online", req.Online); err != nil {
			return mapWUErr(err)
		}
		if _, err := oleutil.PutProperty(searcher, "ServerSelection", 0); err == nil {
			// ssDefault — ignore failure on older WUAPI
		}
		out := &UpdateResult{Pending: []UpdateItem{}, Installed: []UpdateItem{}, Online: req.Online}
		pending, trunc, err := searchUpdates(searcher, "IsInstalled=0 and IsHidden=0", maxPending)
		if err != nil {
			return err
		}
		out.Pending = pending
		out.Truncated = trunc
		installed, histTrunc, err := queryHistory(searcher, maxHistory)
		if err != nil {
			return err
		}
		out.Installed = installed
		if histTrunc {
			out.Truncated = true
		}
		result = out
		return nil
	})
	return result, err
}

func withWUAPI(fn func(searcher *ole.IDispatch) error) error {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	uninit := true
	if err := ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED); err != nil {
		code := oleCode(err)
		if code == rpcEChangedMode {
			uninit = false
		} else if code != ole.S_OK && code != sFalse {
			return mapWUErr(err)
		}
	}
	if uninit {
		defer ole.CoUninitialize()
	}
	unknown, err := oleutil.CreateObject("Microsoft.Update.Session")
	if err != nil {
		return mapWUErr(err)
	}
	if unknown == nil {
		return ErrWUAPI
	}
	defer unknown.Release()
	session, err := unknown.QueryInterface(ole.IID_IDispatch)
	if err != nil {
		return mapWUErr(err)
	}
	defer session.Release()
	_, _ = oleutil.PutProperty(session, "ClientApplicationID", "Mnag.pt Agent")
	searcherVar, err := oleutil.CallMethod(session, "CreateUpdateSearcher")
	if err != nil {
		return mapWUErr(err)
	}
	searcher := searcherVar.ToIDispatch()
	if searcher == nil {
		_ = searcherVar.Clear()
		return ErrWUAPI
	}
	searcher.AddRef()
	_ = searcherVar.Clear()
	defer searcher.Release()
	return fn(searcher)
}

func searchUpdates(searcher *ole.IDispatch, criteria string, capN int) ([]UpdateItem, bool, error) {
	resVar, err := oleutil.CallMethod(searcher, "Search", criteria)
	if err != nil {
		return nil, false, mapWUErr(err)
	}
	res := resVar.ToIDispatch()
	if res == nil {
		_ = resVar.Clear()
		return nil, false, ErrWUAPI
	}
	res.AddRef()
	_ = resVar.Clear()
	defer res.Release()
	collVar, err := oleutil.GetProperty(res, "Updates")
	if err != nil {
		return nil, false, mapWUErr(err)
	}
	coll := collVar.ToIDispatch()
	if coll == nil {
		_ = collVar.Clear()
		return []UpdateItem{}, false, nil
	}
	coll.AddRef()
	_ = collVar.Clear()
	defer coll.Release()
	return readUpdateCollection(coll, capN, false)
}

func queryHistory(searcher *ole.IDispatch, capN int) ([]UpdateItem, bool, error) {
	countVar, err := oleutil.CallMethod(searcher, "GetTotalHistoryCount")
	if err != nil {
		return []UpdateItem{}, false, nil
	}
	total := intFromAny(countVar.Value())
	_ = countVar.Clear()
	if total <= 0 {
		return []UpdateItem{}, false, nil
	}
	n := capN
	if total < n {
		n = total
	}
	histVar, err := oleutil.CallMethod(searcher, "QueryHistory", 0, n)
	if err != nil {
		return nil, false, mapWUErr(err)
	}
	hist := histVar.ToIDispatch()
	if hist == nil {
		_ = histVar.Clear()
		return []UpdateItem{}, false, nil
	}
	hist.AddRef()
	_ = histVar.Clear()
	defer hist.Release()
	items, _, err := readUpdateCollection(hist, capN, true)
	return items, total > capN, err
}

func readUpdateCollection(coll *ole.IDispatch, capN int, history bool) ([]UpdateItem, bool, error) {
	countVar, err := oleutil.GetProperty(coll, "Count")
	if err != nil {
		return nil, false, mapWUErr(err)
	}
	count := intFromAny(countVar.Value())
	_ = countVar.Clear()
	if count < 0 {
		count = 0
	}
	truncated := count > capN
	if count > capN {
		count = capN
	}
	out := make([]UpdateItem, 0, count)
	for i := 0; i < count; i++ {
		itemVar, err := oleutil.GetProperty(coll, "Item", i)
		if err != nil {
			continue
		}
		item := itemVar.ToIDispatch()
		if item == nil {
			_ = itemVar.Clear()
			continue
		}
		item.AddRef()
		_ = itemVar.Clear()
		parsed := updateFromDispatch(item, history)
		item.Release()
		if parsed.Title == "" {
			continue
		}
		out = append(out, parsed)
	}
	return out, truncated, nil
}

func updateFromDispatch(item *ole.IDispatch, history bool) UpdateItem {
	u := UpdateItem{Title: stringProp(item, "Title"), KB: kbArticles(item)}
	if history {
		u.Date = dateProp(item, "Date")
		u.Result = historyResultName(intFromAny(intPropValue(item, "ResultCode")))
		return u
	}
	u.Severity = stringProp(item, "MsrcSeverity")
	u.IsDownloaded = boolProp(item, "IsDownloaded")
	if ibVar, err := oleutil.GetProperty(item, "InstallationBehavior"); err == nil {
		if ib := ibVar.ToIDispatch(); ib != nil {
			ib.AddRef()
			reboot := intFromAny(intPropValue(ib, "RebootBehavior"))
			ib.Release()
			u.RebootRequired = reboot == 1 || reboot == 2
		}
		_ = ibVar.Clear()
	}
	return u
}

func kbArticles(item *ole.IDispatch) []string {
	v, err := oleutil.GetProperty(item, "KBArticleIDs")
	if err != nil {
		return nil
	}
	coll := v.ToIDispatch()
	if coll == nil {
		_ = v.Clear()
		return nil
	}
	coll.AddRef()
	_ = v.Clear()
	defer coll.Release()
	countVar, err := oleutil.GetProperty(coll, "Count")
	if err != nil {
		return nil
	}
	count := intFromAny(countVar.Value())
	_ = countVar.Clear()
	if count > maxKB {
		count = maxKB
	}
	var out []string
	for i := 0; i < count; i++ {
		itemVar, err := oleutil.GetProperty(coll, "Item", i)
		if err != nil {
			continue
		}
		s := strings.TrimSpace(itemVar.ToString())
		if s == "" {
			if val, ok := itemVar.Value().(string); ok {
				s = strings.TrimSpace(val)
			}
		}
		_ = itemVar.Clear()
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

func stringProp(disp *ole.IDispatch, name string) string {
	v, err := oleutil.GetProperty(disp, name)
	if err != nil {
		return ""
	}
	defer v.Clear()
	if s := v.ToString(); s != "" {
		return s
	}
	if val, ok := v.Value().(string); ok {
		return val
	}
	return ""
}

func boolProp(disp *ole.IDispatch, name string) bool {
	v, err := oleutil.GetProperty(disp, name)
	if err != nil {
		return false
	}
	defer v.Clear()
	switch n := v.Value().(type) {
	case bool:
		return n
	case int, int8, int16, int32, int64:
		return intFromAny(n) != 0
	default:
		return false
	}
}

func intPropValue(disp *ole.IDispatch, name string) any {
	v, err := oleutil.GetProperty(disp, name)
	if err != nil {
		return 0
	}
	defer v.Clear()
	return v.Value()
}

func dateProp(disp *ole.IDispatch, name string) string {
	v, err := oleutil.GetProperty(disp, name)
	if err != nil {
		return ""
	}
	defer v.Clear()
	switch t := v.Value().(type) {
	case time.Time:
		if t.IsZero() {
			return ""
		}
		return t.UTC().Format(time.RFC3339)
	default:
		return ""
	}
}

func intFromAny(v any) int {
	switch n := v.(type) {
	case int:
		return n
	case int8:
		return int(n)
	case int16:
		return int(n)
	case int32:
		return int(n)
	case int64:
		return int(n)
	case uint:
		return int(n)
	case uint8:
		return int(n)
	case uint16:
		return int(n)
	case uint32:
		return int(n)
	case uint64:
		return int(n)
	case float64:
		return int(n)
	case bool:
		if n {
			return 1
		}
	}
	return 0
}

func historyResultName(v int) string {
	switch v {
	case 1:
		return "in_progress"
	case 2:
		return "succeeded"
	case 3:
		return "succeeded_with_errors"
	case 4:
		return "failed"
	case 5:
		return "aborted"
	default:
		return "not_started"
	}
}

func oleCode(err error) uintptr {
	var oleErr *ole.OleError
	if errors.As(err, &oleErr) {
		return oleErr.Code()
	}
	return 0
}

func mapWUErr(err error) error {
	if err == nil {
		return nil
	}
	code := oleCode(err)
	if code == ole.E_ACCESSDENIED {
		return ErrWUAPI
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "access") || strings.Contains(msg, "0x80070422") || strings.Contains(msg, "service") && strings.Contains(msg, "disabled") {
		return ErrWUAPI
	}
	return ErrWUAPI
}
