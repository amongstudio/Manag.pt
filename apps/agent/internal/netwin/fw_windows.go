//go:build windows

package netwin

import (
	"errors"
	"fmt"
	"runtime"
	"strings"
	"time"

	ole "github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

const (
	netFwProfileDomain  = 1
	netFwProfilePrivate = 2
	netFwProfilePublic  = 4
	netFwProfileAll     = 0x7FFFFFFF
	netFwActionBlock    = 0
	netFwActionAllow    = 1
	netFwDirIn          = 1
	netFwDirOut         = 2
	netFwProtoICMPv4    = 1
	netFwProtoTCP       = 6
	netFwProtoUDP       = 17
	netFwProtoAny       = 256
	rpcEChangedMode     = 0x80010106
	sFalse              = 0x00000001
	firewallCOMTimeout  = 20 * time.Second
)

func Firewall() (*FirewallResult, error) {
	var result *FirewallResult
	err := withFirewall(func(policy, rules *ole.IDispatch) error {
		res, err := readFirewall(policy, rules)
		result = res
		return err
	})
	if result == nil {
		result = &FirewallResult{Profiles: []FirewallProfile{}, Rules: []FirewallRule{}}
	}
	if len(result.Profiles) == 0 {
		if extra := firewallFromNetshProfiles(); len(extra) > 0 {
			result.Profiles = extra
		}
	}
	if len(result.Rules) == 0 {
		if extra := firewallFromNetsh(); len(extra) > 0 {
			result.Rules = extra
		} else if extra := firewallFromPowerShell(); len(extra) > 0 {
			result.Rules = extra
		}
		if len(result.Rules) >= maxFirewall {
			result.Truncated = true
		}
	}
	fitFirewall(result)
	if err != nil && len(result.Profiles) == 0 && len(result.Rules) == 0 {
		return nil, err
	}
	return result, nil
}

func SetRule(req RuleRequest) (*WriteResult, error) {
	err := withFirewall(func(_, rules *ole.IDispatch) error {
		existing, err := itemRule(rules, req.Name)
		if err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
		if existing != nil {
			defer existing.Release()
			return applyRule(existing, req, false)
		}
		unk, err := oleutil.CreateObject("HNetCfg.FwRule")
		if err != nil {
			return mapFwErr(err)
		}
		defer unk.Release()
		rule, err := unk.QueryInterface(ole.IID_IDispatch)
		if err != nil {
			return mapFwErr(err)
		}
		defer rule.Release()
		if err := applyRule(rule, req, true); err != nil {
			return err
		}
		if _, err := oleutil.CallMethod(rules, "Add", rule); err != nil {
			return mapFwErr(err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &WriteResult{Name: req.Name, Action: "set"}, nil
}

func DeleteRule(name string) (*WriteResult, error) {
	err := withFirewall(func(_, rules *ole.IDispatch) error {
		if _, err := oleutil.CallMethod(rules, "Remove", name); err != nil {
			return mapFwErr(err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &WriteResult{Name: name, Action: "delete"}, nil
}

func withFirewall(fn func(policy, rules *ole.IDispatch) error) error {
	errCh := make(chan error, 1)
	go func() {
		defer func() {
			if rec := recover(); rec != nil {
				errCh <- fmt.Errorf("firewall_com_panic: %v", rec)
			}
		}()
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		errCh <- withFirewallSTA(fn)
	}()
	select {
	case err := <-errCh:
		return err
	case <-time.After(firewallCOMTimeout):
		return errors.New("firewall_com_timeout")
	}
}

func withFirewallSTA(fn func(policy, rules *ole.IDispatch) error) error {
	uninit := false
	if err := ole.CoInitializeEx(0, ole.COINIT_APARTMENTTHREADED); err != nil {
		code := oleCode(err)
		if code == rpcEChangedMode {
			uninit = false
		} else if code != ole.S_OK && code != sFalse {
			return mapFwErr(err)
		}
	} else {
		uninit = true
	}
	if uninit {
		defer ole.CoUninitialize()
	}
	unknown, err := oleutil.CreateObject("HNetCfg.FwPolicy2")
	if err != nil {
		return mapFwErr(err)
	}
	if unknown == nil {
		return ErrEnumFailed
	}
	defer unknown.Release()
	policy, err := unknown.QueryInterface(ole.IID_IDispatch)
	if err != nil {
		return mapFwErr(err)
	}
	defer policy.Release()
	rulesVar, err := oleutil.GetProperty(policy, "Rules")
	if err != nil {
		return mapFwErr(err)
	}
	rules := rulesVar.ToIDispatch()
	if rules == nil {
		_ = rulesVar.Clear()
		return ErrEnumFailed
	}
	rules.AddRef()
	_ = rulesVar.Clear()
	defer rules.Release()
	return fn(policy, rules)
}

func readFirewall(policy, rules *ole.IDispatch) (*FirewallResult, error) {
	out := &FirewallResult{
		Profiles: readProfiles(policy),
		Rules:    []FirewallRule{},
	}
	if v, err := oleutil.GetProperty(policy, "LocalPolicyModifyState"); err == nil {
		out.ModifyState = modifyStateName(intFromVariant(v))
		_ = v.Clear()
	}
	count := 0
	if v, err := oleutil.GetProperty(rules, "Count"); err == nil {
		count = int(intFromVariant(v))
		_ = v.Clear()
	}
	listed, truncated, err := enumerateRules(rules, count)
	if err == nil && len(listed) > 0 {
		out.Rules = listed
		out.Truncated = truncated
		return out, nil
	}
	if indexed := enumerateRulesByIndex(rules, count); len(indexed) > 0 {
		out.Rules = indexed
		if count > maxFirewall {
			out.Truncated = true
		}
		return out, nil
	}
	if err != nil && len(out.Profiles) == 0 {
		return out, mapFwErr(err)
	}
	return out, nil
}

func enumerateRules(rules *ole.IDispatch, count int) ([]FirewallRule, bool, error) {
	out := []FirewallRule{}
	truncated := false
	err := forEachRule(rules, func(rule *ole.IDispatch) error {
		if len(out) >= maxFirewall {
			truncated = true
			return errEnumDone
		}
		parsed := ruleFromDispatch(rule)
		if parsed.Name == "" {
			parsed.Name = "(unnamed)"
		}
		out = append(out, parsed)
		return nil
	})
	if errors.Is(err, errEnumDone) {
		err = nil
	}
	if count > 0 && len(out) == 0 && err != nil {
		return out, truncated, err
	}
	return out, truncated || (count > maxFirewall), err
}

func enumerateRulesByIndex(rules *ole.IDispatch, count int) []FirewallRule {
	if count <= 0 {
		return nil
	}
	n := count
	if n > maxFirewall {
		n = maxFirewall
	}
	out := make([]FirewallRule, 0, n)
	for i := 1; i <= n; i++ {
		v, err := oleutil.CallMethod(rules, "Item", i)
		if err != nil {
			continue
		}
		rule, owned, err := dispatchFromVar(v)
		_ = v.Clear()
		if err != nil || rule == nil {
			continue
		}
		parsed := ruleFromDispatch(rule)
		if owned {
			rule.Release()
		}
		if parsed.Name == "" {
			parsed.Name = "(unnamed)"
		}
		out = append(out, parsed)
	}
	return out
}

func readProfiles(policy *ole.IDispatch) []FirewallProfile {
	specs := []struct {
		name string
		bit  int32
	}{
		{"domain", netFwProfileDomain},
		{"private", netFwProfilePrivate},
		{"public", netFwProfilePublic},
	}
	out := make([]FirewallProfile, 0, 3)
	for _, spec := range specs {
		p := FirewallProfile{Name: spec.name}
		if v, err := oleutil.GetProperty(policy, "FirewallEnabled", spec.bit); err == nil {
			p.Enabled = boolFromVariant(v)
			_ = v.Clear()
		}
		if v, err := oleutil.GetProperty(policy, "DefaultInboundAction", spec.bit); err == nil {
			p.DefaultInbound = actionName(intFromVariant(v))
			_ = v.Clear()
		}
		if v, err := oleutil.GetProperty(policy, "DefaultOutboundAction", spec.bit); err == nil {
			p.DefaultOutbound = actionName(intFromVariant(v))
			_ = v.Clear()
		}
		out = append(out, p)
	}
	return out
}

func itemRule(rules *ole.IDispatch, name string) (*ole.IDispatch, error) {
	v, err := oleutil.CallMethod(rules, "Item", name)
	if err != nil {
		return nil, mapFwErr(err)
	}
	d := v.ToIDispatch()
	if d == nil {
		_ = v.Clear()
		return nil, ErrNotFound
	}
	d.AddRef()
	_ = v.Clear()
	return d, nil
}

func applyRule(rule *ole.IDispatch, req RuleRequest, creating bool) error {
	if creating {
		if _, err := oleutil.PutProperty(rule, "Name", req.Name); err != nil {
			return mapFwErr(err)
		}
	}
	direction := req.Direction
	if direction == "" {
		direction = "inbound"
	}
	action := req.Action
	if action == "" {
		action = "allow"
	}
	enabled := true
	if req.Enabled != nil {
		enabled = *req.Enabled
	}
	if creating || req.HasDirection {
		if _, err := oleutil.PutProperty(rule, "Direction", directionValue(direction)); err != nil {
			return mapFwErr(err)
		}
	}
	if creating || req.HasAction {
		if _, err := oleutil.PutProperty(rule, "Action", actionValue(action)); err != nil {
			return mapFwErr(err)
		}
	}
	if creating || req.Enabled != nil {
		if _, err := oleutil.PutProperty(rule, "Enabled", enabled); err != nil {
			return mapFwErr(err)
		}
	}
	protocol := req.Protocol
	if protocol == "" && req.LocalPorts != "" {
		protocol = "tcp"
	}
	if protocol == "" && creating {
		protocol = "any"
	}
	if creating || req.HasProtocol || (req.HasLocalPorts && req.LocalPorts != "" && protocol == "") {
		if protocol != "" {
			if _, err := oleutil.PutProperty(rule, "Protocol", protocolValue(protocol)); err != nil {
				return mapFwErr(err)
			}
		}
	}
	if err := putString(rule, "Description", req.Description, creating || req.HasDescription); err != nil {
		return err
	}
	if err := putString(rule, "LocalPorts", req.LocalPorts, creating || req.HasLocalPorts); err != nil {
		return err
	}
	if err := putString(rule, "RemotePorts", req.RemotePorts, creating || req.HasRemotePorts); err != nil {
		return err
	}
	if err := putString(rule, "LocalAddresses", req.LocalAddresses, creating || req.HasLocalAddr); err != nil {
		return err
	}
	if err := putString(rule, "RemoteAddresses", req.RemoteAddresses, creating || req.HasRemoteAddr); err != nil {
		return err
	}
	if err := putString(rule, "ApplicationName", req.Application, creating || req.HasApplication); err != nil {
		return err
	}
	if err := putString(rule, "ServiceName", req.ServiceName, creating || req.HasServiceName); err != nil {
		return err
	}
	if err := putString(rule, "Grouping", req.Grouping, creating || req.HasGrouping); err != nil {
		return err
	}
	if creating || req.HasProfiles {
		profiles := req.Profiles
		if profiles == "" {
			profiles = "all"
		}
		if _, err := oleutil.PutProperty(rule, "Profiles", profilesValue(profiles)); err != nil {
			return mapFwErr(err)
		}
	}
	return nil
}

func putString(rule *ole.IDispatch, name, value string, apply bool) error {
	if !apply || value == "" {
		return nil
	}
	if _, err := oleutil.PutProperty(rule, name, value); err != nil {
		return mapFwErr(err)
	}
	return nil
}

func ruleFromDispatch(rule *ole.IDispatch) FirewallRule {
	direction := "inbound"
	if v, ok := intPropOK(rule, "Direction"); ok {
		direction = directionName(v)
	}
	action := "allow"
	if v, ok := intPropOK(rule, "Action"); ok {
		action = actionName(v)
	}
	protocol := "any"
	if v, ok := intPropOK(rule, "Protocol"); ok {
		protocol = protocolName(v)
	}
	profiles := "all"
	if v, ok := intPropOK(rule, "Profiles"); ok {
		profiles = profilesName(v)
	}
	return FirewallRule{
		Name:            stringProp(rule, "Name"),
		Description:     clipText(stringProp(rule, "Description"), 160),
		Direction:       direction,
		Action:          action,
		Enabled:         boolProp(rule, "Enabled"),
		Protocol:        protocol,
		LocalPorts:      stringProp(rule, "LocalPorts"),
		RemotePorts:     stringProp(rule, "RemotePorts"),
		LocalAddresses:  stringProp(rule, "LocalAddresses"),
		RemoteAddresses: stringProp(rule, "RemoteAddresses"),
		Application:     stringProp(rule, "ApplicationName"),
		ServiceName:     stringProp(rule, "ServiceName"),
		Profiles:        profiles,
		Grouping:        stringProp(rule, "Grouping"),
	}
}

func dispatchFromVar(v *ole.VARIANT) (*ole.IDispatch, bool, error) {
	if v == nil {
		return nil, false, nil
	}
	if d := v.ToIDispatch(); d != nil {
		d.AddRef()
		return d, true, nil
	}
	unk := v.ToIUnknown()
	if unk == nil {
		return nil, false, nil
	}
	d, err := unk.QueryInterface(ole.IID_IDispatch)
	if err != nil {
		return nil, false, err
	}
	return d, true, nil
}

func stringProp(disp *ole.IDispatch, name string) string {
	v, err := oleutil.GetProperty(disp, name)
	if err != nil {
		return ""
	}
	defer v.Clear()
	if s := v.ToString(); s != "" {
		return strings.TrimSpace(s)
	}
	if val, ok := v.Value().(string); ok {
		return strings.TrimSpace(val)
	}
	s := strings.TrimSpace(fmt.Sprint(v.Value()))
	if s == "" || s == "<nil>" {
		return ""
	}
	return s
}

func intProp(disp *ole.IDispatch, name string) int32 {
	v, ok := intPropOK(disp, name)
	if !ok {
		return 0
	}
	return v
}

func intPropOK(disp *ole.IDispatch, name string) (int32, bool) {
	v, err := oleutil.GetProperty(disp, name)
	if err != nil || v == nil {
		return 0, false
	}
	defer v.Clear()
	return intFromVariant(v), true
}

func boolProp(disp *ole.IDispatch, name string) bool {
	v, err := oleutil.GetProperty(disp, name)
	if err != nil {
		return false
	}
	defer v.Clear()
	return boolFromVariant(v)
}

func intFromVariant(v *ole.VARIANT) int32 {
	switch n := v.Value().(type) {
	case int32:
		return n
	case int16:
		return int32(n)
	case int:
		return int32(n)
	case uint32:
		return int32(n)
	case int64:
		return int32(n)
	default:
		return int32(v.Val)
	}
}

func boolFromVariant(v *ole.VARIANT) bool {
	switch n := v.Value().(type) {
	case bool:
		return n
	case int16:
		return n != 0
	default:
		return v.Val != 0
	}
}

func directionValue(v string) int32 {
	if v == "outbound" {
		return netFwDirOut
	}
	return netFwDirIn
}

func directionName(v int32) string {
	if v == netFwDirOut {
		return "outbound"
	}
	return "inbound"
}

func actionValue(v string) int32 {
	if v == "block" {
		return netFwActionBlock
	}
	return netFwActionAllow
}

func actionName(v int32) string {
	if v == netFwActionBlock {
		return "block"
	}
	return "allow"
}

func protocolValue(v string) int32 {
	switch v {
	case "tcp":
		return netFwProtoTCP
	case "udp":
		return netFwProtoUDP
	case "icmp":
		return netFwProtoICMPv4
	default:
		return netFwProtoAny
	}
}

func protocolName(v int32) string {
	switch v {
	case netFwProtoTCP:
		return "tcp"
	case netFwProtoUDP:
		return "udp"
	case netFwProtoICMPv4:
		return "icmp"
	case netFwProtoAny:
		return "any"
	default:
		return "any"
	}
}

func profilesValue(v string) int32 {
	if v == "" || v == "all" {
		return netFwProfileAll
	}
	var bits int32
	for _, p := range strings.Split(v, ",") {
		switch strings.TrimSpace(p) {
		case "domain":
			bits |= netFwProfileDomain
		case "private":
			bits |= netFwProfilePrivate
		case "public":
			bits |= netFwProfilePublic
		}
	}
	if bits == 0 {
		return netFwProfileAll
	}
	return bits
}

func profilesName(v int32) string {
	if v == netFwProfileAll || v == (netFwProfileDomain|netFwProfilePrivate|netFwProfilePublic) {
		return "all"
	}
	var parts []string
	if v&netFwProfileDomain != 0 {
		parts = append(parts, "domain")
	}
	if v&netFwProfilePrivate != 0 {
		parts = append(parts, "private")
	}
	if v&netFwProfilePublic != 0 {
		parts = append(parts, "public")
	}
	if len(parts) == 0 {
		return "all"
	}
	return strings.Join(parts, ",")
}

func modifyStateName(v int32) string {
	switch v {
	case 1:
		return "gp_override"
	case 2:
		return "inbound_blocked"
	default:
		return "ok"
	}
}

func oleCode(err error) uintptr {
	var oleErr *ole.OleError
	if errors.As(err, &oleErr) {
		return oleErr.Code()
	}
	return 0
}

func mapFwErr(err error) error {
	if err == nil {
		return nil
	}
	code := oleCode(err)
	switch code {
	case ole.E_ACCESSDENIED:
		return ErrAccessDenied
	case 0x80070002, 0x80070490:
		return ErrNotFound
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "access") {
		return ErrAccessDenied
	}
	if strings.Contains(msg, "not found") || strings.Contains(msg, "file not found") {
		return ErrNotFound
	}
	return err
}
