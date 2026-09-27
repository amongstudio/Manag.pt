//go:build !windows

package credwin

func List(ListRequest) (*ListResult, error) { return nil, ErrUnsupported }

func Write(WriteRequest) (*Credential, error) { return nil, ErrUnsupported }

func Delete(DeleteRequest) (map[string]any, error) { return nil, ErrUnsupported }

func Restore(RestoreRequest) (map[string]any, error) { return nil, ErrUnsupported }
