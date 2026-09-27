//go:build !windows

package netwin

func Adapters() (*AdapterList, error) {
	return nil, ErrUnsupported
}

func Ports(PortsRequest) (*PortList, error) {
	return nil, ErrUnsupported
}

func Firewall() (*FirewallResult, error) {
	return nil, ErrUnsupported
}

func SetRule(RuleRequest) (*WriteResult, error) {
	return nil, ErrUnsupported
}

func DeleteRule(string) (*WriteResult, error) {
	return nil, ErrUnsupported
}
