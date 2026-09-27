package credwin

import (
	"encoding/binary"
	"os"
	"strconv"
	"strings"
	"unicode/utf8"
)

type sqliteCell struct {
	text map[string]string
	blob map[string][]byte
}

func scanSqliteTable(path, table string, cols []string) []map[string]string {
	return scanSqliteTableWithBlobs(path, table, cols, nil)
}

func scanSqliteTableWithBlobs(path, table string, cols, blobCols []string) []map[string]string {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) < 100 || string(raw[:6]) != "SQLite" {
		return nil
	}
	pageSize := int(binary.BigEndian.Uint16(raw[16:18]))
	if pageSize == 1 {
		pageSize = 65536
	}
	if pageSize < 512 || len(raw) < pageSize {
		return nil
	}
	wanted := map[string]bool{}
	for _, c := range cols {
		wanted[c] = true
	}
	blobSet := map[string]bool{}
	for _, c := range blobCols {
		blobSet[c] = true
	}
	root := sqliteMasterRoot(raw, pageSize, table)
	if root <= 0 {
		return nil
	}
	names := sqliteTableCols(raw, pageSize, table)
	if len(names) == 0 {
		return nil
	}
	var rows []map[string]string
	walkBTree(raw, pageSize, root, func(payload []byte) {
		rec := decodeRecordValues(payload)
		if len(rec) == 0 {
			return
		}
		row := map[string]string{}
		for i, name := range names {
			if !wanted[name] || i >= len(rec) {
				continue
			}
			if blobSet[name] {
				if b, ok := rec[i].([]byte); ok {
					row[name] = string(b)
				}
				continue
			}
			if s, ok := rec[i].(string); ok {
				row[name] = s
			}
		}
		if len(row) > 0 {
			rows = append(rows, row)
		}
	})
	return rows
}

func sqliteMasterRoot(raw []byte, pageSize int, table string) int {
	var root int
	walkBTree(raw, pageSize, 1, func(payload []byte) {
		rec := decodeRecord(payload)
		if len(rec) < 5 || rec[0] != "table" || !strings.EqualFold(rec[1], table) {
			return
		}
		if n, err := strconv.Atoi(rec[3]); err == nil {
			root = n
		}
	})
	return root
}

func sqliteTableCols(raw []byte, pageSize int, table string) []string {
	var sql string
	walkBTree(raw, pageSize, 1, func(payload []byte) {
		rec := decodeRecord(payload)
		if len(rec) >= 5 && rec[0] == "table" && strings.EqualFold(rec[1], table) {
			sql = rec[4]
		}
	})
	if sql == "" {
		return nil
	}
	i := strings.Index(sql, "(")
	j := strings.LastIndex(sql, ")")
	if i < 0 || j <= i {
		return nil
	}
	var cols []string
	for _, part := range strings.Split(sql[i+1:j], ",") {
		part = strings.TrimSpace(part)
		up := strings.ToUpper(part)
		if part == "" || strings.HasPrefix(up, "PRIMARY") || strings.HasPrefix(up, "UNIQUE") || strings.HasPrefix(up, "CHECK") || strings.HasPrefix(up, "FOREIGN") {
			continue
		}
		name := strings.Fields(part)[0]
		cols = append(cols, strings.Trim(name, "`\"[]"))
	}
	return cols
}

func walkBTree(raw []byte, pageSize, page int, fn func([]byte)) {
	if page <= 0 {
		return
	}
	start := (page - 1) * pageSize
	if start < 0 || start >= len(raw) {
		return
	}
	end := start + pageSize
	if end > len(raw) {
		end = len(raw)
	}
	pageBuf := raw[start:end]
	headerOff := 0
	if page == 1 {
		headerOff = 100
	}
	if headerOff+5 >= len(pageBuf) {
		return
	}
	kind := pageBuf[headerOff]
	cellCount := int(binary.BigEndian.Uint16(pageBuf[headerOff+3 : headerOff+5]))
	cellOff := headerOff + 8
	if kind == 5 || kind == 2 {
		cellOff = headerOff + 12
	}
	for i := 0; i < cellCount; i++ {
		idx := cellOff + i*2
		if idx+2 > len(pageBuf) {
			return
		}
		co := int(binary.BigEndian.Uint16(pageBuf[idx : idx+2]))
		if co >= len(pageBuf) {
			continue
		}
		cell := pageBuf[co:]
		switch kind {
		case 5:
			if len(cell) < 4 {
				continue
			}
			child := int(binary.BigEndian.Uint32(cell[:4]))
			walkBTree(raw, pageSize, child, fn)
		case 13:
			if payload, ok := leafPayload(raw, pageSize, cell); ok {
				fn(payload)
			}
		}
	}
	if kind == 5 && headerOff+12 <= len(pageBuf) {
		right := int(binary.BigEndian.Uint32(pageBuf[headerOff+8 : headerOff+12]))
		if right > 0 {
			walkBTree(raw, pageSize, right, fn)
		}
	}
}

func leafPayload(raw []byte, pageSize int, cell []byte) ([]byte, bool) {
	payloadLen, n := readVarint(cell)
	if n == 0 {
		return nil, false
	}
	cell = cell[n:]
	_, n = readVarint(cell)
	if n == 0 {
		return nil, false
	}
	cell = cell[n:]
	if int(payloadLen) <= len(cell) {
		return cell[:payloadLen], true
	}
	if len(cell) < 4 {
		return nil, false
	}
	overflow := int(binary.BigEndian.Uint32(cell[len(cell)-4:]))
	local := append([]byte(nil), cell[:len(cell)-4]...)
	return readOverflowPayload(raw, pageSize, overflow, local, int(payloadLen)), true
}

func readOverflowPayload(raw []byte, pageSize, page int, prefix []byte, total int) []byte {
	out := append([]byte(nil), prefix...)
	for page > 0 && len(out) < total {
		start := (page - 1) * pageSize
		if start < 0 || start+pageSize > len(raw) {
			break
		}
		pageBuf := raw[start : start+pageSize]
		if len(pageBuf) < 4 {
			break
		}
		next := int(binary.BigEndian.Uint32(pageBuf[:4]))
		chunk := pageBuf[4:]
		need := total - len(out)
		if need <= 0 {
			break
		}
		if len(chunk) > need {
			chunk = chunk[:need]
		}
		out = append(out, chunk...)
		page = next
	}
	if len(out) > total {
		out = out[:total]
	}
	return out
}

func decodeRecord(payload []byte) []string {
	vals := decodeRecordValues(payload)
	out := make([]string, 0, len(vals))
	for _, v := range vals {
		switch t := v.(type) {
		case string:
			out = append(out, t)
		case []byte:
			out = append(out, string(t))
		default:
			out = append(out, "")
		}
	}
	return out
}

func decodeRecordValues(payload []byte) []any {
	if len(payload) == 0 {
		return nil
	}
	hdrLen, n := readVarint(payload)
	if n == 0 || int(hdrLen) > len(payload) {
		return nil
	}
	var types []int64
	rest := payload[n:hdrLen]
	for len(rest) > 0 {
		t, m := readVarint(rest)
		if m == 0 {
			break
		}
		types = append(types, t)
		rest = rest[m:]
	}
	body := payload[hdrLen:]
	out := make([]any, 0, len(types))
	for _, t := range types {
		val, sz := serialValueRaw(body, t)
		if sz > len(body) {
			break
		}
		out = append(out, val)
		body = body[sz:]
	}
	return out
}

func serialValue(body []byte, t int64) (string, int) {
	val, sz := serialValueRaw(body, t)
	switch v := val.(type) {
	case string:
		return v, sz
	case []byte:
		return string(v), sz
	default:
		return "", sz
	}
}

func serialValueRaw(body []byte, t int64) (any, int) {
	switch t {
	case 0:
		return "", 0
	case 1:
		if len(body) < 1 {
			return "", 0
		}
		return strconv.FormatInt(int64(int8(body[0])), 10), 1
	case 2:
		if len(body) < 2 {
			return "", 0
		}
		return strconv.FormatInt(int64(int16(binary.BigEndian.Uint16(body[:2]))), 10), 2
	case 3:
		if len(body) < 3 {
			return "", 0
		}
		v := int64(body[0])<<16 | int64(body[1])<<8 | int64(body[2])
		if v&0x800000 != 0 {
			v |= ^int64(0xFFFFFF)
		}
		return strconv.FormatInt(v, 10), 3
	case 4:
		if len(body) < 4 {
			return "", 0
		}
		return strconv.FormatInt(int64(int32(binary.BigEndian.Uint32(body[:4]))), 10), 4
	case 5:
		if len(body) < 6 {
			return "", 0
		}
		v := int64(binary.BigEndian.Uint16(body[:2]))<<32 | int64(binary.BigEndian.Uint32(body[2:6]))
		return strconv.FormatInt(v, 10), 6
	case 6, 7:
		if len(body) < 8 {
			return "", 0
		}
		return strconv.FormatInt(int64(binary.BigEndian.Uint64(body[:8])), 10), 8
	case 8:
		return "0", 0
	case 9:
		return "1", 0
	default:
		if t >= 12 && t%2 == 0 {
			n := int((t - 12) / 2)
			if n > len(body) {
				n = len(body)
			}
			b := append([]byte(nil), body[:n]...)
			return b, n
		}
		if t >= 13 && t%2 == 1 {
			n := int((t - 13) / 2)
			if n > len(body) {
				n = len(body)
			}
			s := string(body[:n])
			if !utf8.ValidString(s) {
				s = strings.ToValidUTF8(s, "")
			}
			return s, n
		}
	}
	return "", 0
}

func readVarint(b []byte) (int64, int) {
	var v int64
	for i := 0; i < len(b) && i < 9; i++ {
		v = (v << 7) | int64(b[i]&0x7f)
		if b[i]&0x80 == 0 {
			return v, i + 1
		}
	}
	return 0, 0
}
