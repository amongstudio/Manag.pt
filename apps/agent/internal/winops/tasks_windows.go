//go:build windows

package winops

import (
	"fmt"
	"path"
	"strings"

	ole "github.com/go-ole/go-ole"
	"github.com/go-ole/go-ole/oleutil"
)

const (
	taskEnumHidden = 1
	taskStateDisabled = 1
	taskStateQueued   = 2
	taskStateReady    = 3
	taskStateRunning  = 4
)

func Tasks(req TasksRequest) (*TaskList, error) {
	var out *TaskList
	err := withSTA(func() error {
		svc, err := createDispatch("Schedule.Service")
		if err != nil {
			return mapTaskErr(err)
		}
		defer svc.Release()
		if _, err := oleutil.CallMethod(svc, "Connect"); err != nil {
			return mapTaskErr(err)
		}
		folderVar, err := oleutil.CallMethod(svc, "GetFolder", `\`)
		if err != nil {
			return mapTaskErr(err)
		}
		root, owned := dispatchFromVar(folderVar)
		_ = folderVar.Clear()
		if root == nil {
			return ErrTaskAccessDenied
		}
		if owned {
			defer root.Release()
		}
		res := &TaskList{Tasks: []ScheduledTask{}}
		walkTaskFolder(root, req.Query, res)
		out = res
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

func SetTaskEnabled(req TaskWriteRequest) (*TaskWriteResult, error) {
	err := withSTA(func() error {
		svc, err := createDispatch("Schedule.Service")
		if err != nil {
			return mapTaskErr(err)
		}
		defer svc.Release()
		if _, err := oleutil.CallMethod(svc, "Connect"); err != nil {
			return mapTaskErr(err)
		}
		folderPath, name := splitTaskPath(req.Path)
		folderVar, err := oleutil.CallMethod(svc, "GetFolder", folderPath)
		if err != nil {
			return mapTaskErr(err)
		}
		folder, owned := dispatchFromVar(folderVar)
		_ = folderVar.Clear()
		if folder == nil {
			return ErrTaskNotFound
		}
		if owned {
			defer folder.Release()
		}
		taskVar, err := oleutil.CallMethod(folder, "GetTask", name)
		if err != nil {
			return mapTaskErr(err)
		}
		task, keep := dispatchFromVar(taskVar)
		_ = taskVar.Clear()
		if task == nil {
			return ErrTaskNotFound
		}
		if keep {
			defer task.Release()
		}
		if _, err := oleutil.PutProperty(task, "Enabled", req.Enabled); err != nil {
			return mapTaskErr(err)
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &TaskWriteResult{Path: req.Path, Enabled: req.Enabled, Action: "set_enabled"}, nil
}

func walkTaskFolder(folder *ole.IDispatch, query string, out *TaskList) {
	if folder == nil || out.Truncated {
		return
	}
	tasksVar, err := oleutil.CallMethod(folder, "GetTasks", taskEnumHidden)
	if err == nil {
		tasks, owned := dispatchFromVar(tasksVar)
		_ = tasksVar.Clear()
		if tasks != nil {
			collectTasks(tasks, query, out)
			if owned {
				tasks.Release()
			}
		}
	}
	if out.Truncated {
		return
	}
	foldersVar, err := oleutil.CallMethod(folder, "GetFolders", 0)
	if err != nil {
		return
	}
	folders, owned := dispatchFromVar(foldersVar)
	_ = foldersVar.Clear()
	if folders == nil {
		return
	}
	if owned {
		defer folders.Release()
	}
	_ = oleutil.ForEach(folders, func(item *ole.VARIANT) error {
		defer item.Clear()
		if out.Truncated {
			return nil
		}
		sub, keep := dispatchFromVar(item)
		if sub == nil {
			return nil
		}
		walkTaskFolder(sub, query, out)
		if keep {
			sub.Release()
		}
		return nil
	})
}

func collectTasks(tasks *ole.IDispatch, query string, out *TaskList) {
	_ = oleutil.ForEach(tasks, func(item *ole.VARIANT) error {
		defer item.Clear()
		if out.Truncated {
			return nil
		}
		if len(out.Tasks) >= maxTasks {
			out.Truncated = true
			return nil
		}
		task, keep := dispatchFromVar(item)
		if task == nil {
			return nil
		}
		if keep {
			defer task.Release()
		}
		row := taskFromDispatch(task)
		if row.Name == "" && row.Path == "" {
			return nil
		}
		if query != "" && !taskMatches(row, query) {
			return nil
		}
		out.Tasks = append(out.Tasks, row)
		return nil
	})
}

func taskFromDispatch(task *ole.IDispatch) ScheduledTask {
	row := ScheduledTask{
		Name:        propString(task, "Name"),
		Path:        propString(task, "Path"),
		Enabled:     propBool(task, "Enabled"),
		State:       taskStateName(propInt(task, "State")),
		LastRunTime: propTime(task, "LastRunTime"),
		NextRunTime: propTime(task, "NextRunTime"),
		MissedRuns:  uint32(propInt(task, "NumberOfMissedRuns")),
	}
	if n := propInt(task, "LastTaskResult"); n != 0 {
		row.LastTaskResult = fmt.Sprintf("0x%08x", uint32(n))
	}
	if defVar, err := oleutil.GetProperty(task, "Definition"); err == nil {
		def, keep := dispatchFromVar(defVar)
		_ = defVar.Clear()
		if def != nil {
			if infoVar, err := oleutil.GetProperty(def, "RegistrationInfo"); err == nil {
				info, keepInfo := dispatchFromVar(infoVar)
				_ = infoVar.Clear()
				if info != nil {
					row.Author = propString(info, "Author")
					if keepInfo {
						info.Release()
					}
				}
			}
			if keep {
				def.Release()
			}
		}
	}
	if row.Path == "" && row.Name != "" {
		row.Path = `\` + row.Name
	}
	return row
}

func taskMatches(row ScheduledTask, query string) bool {
	q := strings.ToLower(query)
	return strings.Contains(strings.ToLower(row.Name), q) || strings.Contains(strings.ToLower(row.Path), q)
}

func taskStateName(v int) string {
	switch v {
	case taskStateDisabled:
		return "disabled"
	case taskStateQueued:
		return "queued"
	case taskStateReady:
		return "ready"
	case taskStateRunning:
		return "running"
	default:
		return "unknown"
	}
}

func splitTaskPath(full string) (folder, name string) {
	n := strings.TrimSpace(strings.ReplaceAll(full, "/", `\`))
	n = strings.TrimRight(n, `\`)
	if n == "" {
		return `\`, ""
	}
	dir, base := path.Split(strings.ReplaceAll(n, `\`, "/"))
	folder = strings.ReplaceAll(strings.TrimRight(dir, "/"), "/", `\`)
	if folder == "" {
		folder = `\`
	}
	if !strings.HasPrefix(folder, `\`) {
		folder = `\` + folder
	}
	return folder, base
}

func mapTaskErr(err error) error {
	if err == nil {
		return nil
	}
	if isAccessDenied(err) {
		return ErrTaskAccessDenied
	}
	code := oleCode(err)
	if code == 0x80070002 || code == 0x80070490 {
		return ErrTaskNotFound
	}
	msg := strings.ToLower(err.Error())
	if strings.Contains(msg, "not found") || strings.Contains(msg, "cannot find") {
		return ErrTaskNotFound
	}
	return err
}
