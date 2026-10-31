//go:build js

// Command fossil is go-libfossil inside a Durable Object: one repository per
// object, stored in the object's SQLite through dosql.
//
// JS calls globalThis.fossilDO.call(requestJSON, body?) once per request, with
// __dosql bound to the calling object's storage, inside transactionSync. The
// reply is JSON: {ok, result} or {error, code}, plus aborted when the request
// must be rolled back. Bytes travel as base64.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"syscall/js"
	"time"

	libfossil "github.com/danmestas/go-libfossil"
	"github.com/danmestas/go-libfossil/db"
)

// The object holds exactly one repository; the path only names it to go-libfossil.
const repoPath = "/repo.fossil"

func init() {
	db.Register(db.DriverConfig{Name: "dosql", BuildDSN: func(p string, _ map[string]string) string { return p }})
}

type request struct {
	Op          string            `json:"op"`
	ProjectName string            `json:"projectName"`
	User        string            `json:"user"`
	Comment     string            `json:"comment"`
	Parent      string            `json:"parent"` // check-in the change was based on; "" skips the check
	At          string            `json:"at"`     // check-in, tag or branch; "" is the trunk tip
	Path        string            `json:"path"`
	Name        string            `json:"name"`
	Data        string            `json:"data"`  // base64
	Files       map[string]string `json:"files"` // path -> base64
	ReadToken   string            `json:"readToken"`
	WriteToken  string            `json:"writeToken"`
	Cookie      string            `json:"cookie"`
	Fields      map[string]string `json:"fields"`     // ticket field -> value; "+name" appends
	TicketUUID  string            `json:"ticketUuid"` // a ticket's id or a unique prefix of it
	Hash        string            `json:"hash"`       // timelineSince: entries that arrived after this artifact
	Types       []string          `json:"types"`      // timelineSince: ci, t, w, f; none is all
	Limit       int               `json:"limit"`      // ticketThreads: at most this many tickets
	Target      string            `json:"target"`     // attachments: the ticket they are on
	SHA256      string            `json:"sha256"`     // attachAddExternal: the bytes in R2
	Size        int64             `json:"size"`       // attachAddExternal
	Type        string            `json:"type"`       // attachAddExternal
	Guard       string            `json:"guard"`      // attachments: the only author whose attachment may change
	MaxCount    int               `json:"maxCount"`   // attachAdd*: the most current attachments the repository may hold
}

// Fossil logins for sync: the edit and read links' tokens are their passwords.
const (
	editorLogin = "editor"
	viewerLogin = "viewer"
	editorCaps  = "giyo"
)

func handle(req request, body []byte) (any, error) {
	if req.Op == "create" {
		return create(req)
	}
	r, err := libfossil.Open(repoPath)
	if err != nil {
		return nil, fail("not_found", "%v", err)
	}
	defer r.Close()

	switch req.Op {
	case "tip":
		tip, err := tipOf(r, "")
		return map[string]any{"tip": tip}, err

	case "info":
		tip, err := tipOf(r, "")
		if err != nil {
			return nil, err
		}
		name, _ := r.Config("project-name")
		entries, err := r.Timeline(libfossil.TimelineOpts{Type: libfossil.EventKindCheckin})
		if err != nil {
			return nil, err
		}
		timeline := make([]map[string]any, 0, len(entries))
		for _, e := range entries {
			timeline = append(timeline, map[string]any{
				"uuid": e.UUID, "comment": e.Comment, "user": e.User,
				"time": e.Time.UTC().Format(time.RFC3339), "parents": nonNil(e.Parents),
			})
		}
		return map[string]any{"tip": tip, "projectName": name, "timeline": timeline}, nil

	case "commit":
		return commit(r, req)

	case "bundle":
		rid, uuid, err := resolve(r, req.At)
		if err != nil {
			return nil, err
		}
		entries, err := r.ListFiles(rid)
		if err != nil {
			return nil, err
		}
		// A file can be missing (a phantom) when a push stored the check-in
		// but its content never arrived; show the rest and name the gap.
		files, missing := map[string]string{}, []string{}
		for _, f := range entries {
			b, err := r.ReadFile(rid, f.Name)
			if err != nil {
				missing = append(missing, f.Name)
				continue
			}
			files[f.Name] = base64.StdEncoding.EncodeToString(b)
		}
		return map[string]any{"checkin": uuid, "files": files, "missing": missing}, nil

	case "preview":
		rid, _, err := resolve(r, "")
		if err != nil {
			return nil, err
		}
		entries, err := r.ListFiles(rid)
		if err != nil {
			return nil, err
		}
		path := ""
		for _, f := range entries {
			name := strings.ToLower(f.Name)
			if strings.HasSuffix(name, ".html") || strings.HasSuffix(name, ".htm") {
				if path == "" || f.Name < path {
					path = f.Name
				}
				if name == "index.html" {
					path = f.Name
					break
				}
			}
		}
		if path == "" {
			return map[string]any{"reason": "no_html"}, nil
		}
		// Read only the entry file, never its siblings. Bound the payload sent
		// across the WASM boundary; do not truncate markup into a misleading view.
		b, err := r.ReadFile(rid, path)
		if err != nil {
			return map[string]any{"reason": "missing"}, nil
		}
		if len(b) > 256*1024 {
			return map[string]any{"reason": "too_large"}, nil
		}
		return map[string]any{"data": base64.StdEncoding.EncodeToString(b)}, nil

	case "raw":
		rid, uuid, err := resolve(r, req.At)
		if err != nil {
			return nil, err
		}
		b, err := r.ReadFile(rid, req.Path)
		if err != nil {
			return nil, fail("not_found", "%s is not in check-in %s", req.Path, uuid[:10])
		}
		return map[string]any{"checkin": uuid, "data": base64.StdEncoding.EncodeToString(b)}, nil

	case "uvGet":
		b, _, _, err := r.UVRead(req.Name)
		if err != nil || b == nil {
			return map[string]any{"data": nil}, nil
		}
		return map[string]any{"data": base64.StdEncoding.EncodeToString(b)}, nil

	case "uvSet":
		data, err := base64.StdEncoding.DecodeString(req.Data)
		if err != nil {
			return nil, fail("bad_request", "data is not base64")
		}
		if err := checkStorable(req.Name, data); err != nil {
			return nil, fail("too_large", "%v", err)
		}
		return map[string]any{"ok": true}, r.UVWrite(req.Name, data, time.Now())

	case "uvList":
		entries, err := r.UVList()
		if err != nil {
			return nil, err
		}
		names := []string{}
		for _, e := range entries {
			names = append(names, e.Name)
		}
		return names, nil

	case "sync":
		if err := grantUnversioned(r); err != nil {
			return nil, err
		}
		reply, err := r.HandleSyncWithOpts(context.Background(), body, libfossil.HandleOpts{LoginCookie: req.Cookie, MaxStoredBytes: maxStored})
		var refused *libfossil.RefusedError
		if errors.As(err, &refused) {
			// The request rolled back and stores nothing. The client must see
			// why, not the rollback itself; the abort reason becomes its error card.
			aborted = refused.Message
			return nil, err
		}
		if err != nil {
			return nil, err
		}
		return map[string]any{"data": base64.StdEncoding.EncodeToString(reply)}, nil

	case "verify":
		return map[string]any{"ok": true}, r.Verify()
	}
	if strings.HasPrefix(req.Op, "attach") {
		content, err := base64.StdEncoding.DecodeString(req.Data)
		if err != nil {
			return nil, fail("bad_request", "data is not base64")
		}
		a := attachReq{Target: req.Target, Name: req.Name, User: req.User, Comment: req.Comment,
			Content: content, SHA256: req.SHA256, Size: req.Size, Type: req.Type, Guard: req.Guard, MaxCount: req.MaxCount}
		if result, ok, err := attachOp(r, req.Op, a); ok {
			return result, err
		}
	}
	if result, ok, err := ticketOp(r, req); ok {
		return result, err
	}
	return nil, fail("bad_request", "unknown op %q", req.Op)
}

// grantUnversioned gives the editor login the unversioned-push capability (y)
// that repositories made before attached.json lack. Editors can already write
// unversioned files through uvSet, so this widens nothing; it lets a clone's
// `fossil uv sync` do the same.
func grantUnversioned(r *libfossil.Repo) error {
	var caps string
	if err := r.DB().QueryRow("SELECT cap FROM user WHERE login=?", editorLogin).Scan(&caps); err != nil || strings.Contains(caps, "y") {
		return nil
	}
	return r.SetCaps(editorLogin, editorCaps)
}

func create(req request) (any, error) {
	r, err := libfossil.Create(repoPath, libfossil.CreateOpts{User: req.User})
	if err != nil {
		return nil, err
	}
	defer r.Close()
	if err := r.SetConfig("project-name", req.ProjectName); err != nil {
		return nil, err
	}
	// fossil new lets nobody clone and read; these repositories are private.
	for _, login := range []string{"nobody", "anonymous"} {
		if err := r.SetCaps(login, ""); err != nil {
			return nil, err
		}
	}
	for login, pw := range map[string]string{editorLogin: req.WriteToken, viewerLogin: req.ReadToken} {
		caps := "go" // clone, check out
		if login == editorLogin {
			caps = editorCaps // and check in, and push unversioned files (attached.json)
		}
		if err := r.CreateUser(libfossil.UserOpts{Login: login, Password: pw, Caps: caps}); err != nil {
			return nil, err
		}
	}
	if len(req.Files) == 0 {
		return map[string]any{"tip": ""}, nil
	}
	return commit(r, req)
}

// commit checks files in on top of the trunk tip. A non-empty Parent must
// still be the tip, or someone else committed first.
func commit(r *libfossil.Repo, req request) (any, error) {
	if strings.TrimSpace(req.Comment) == "" || strings.TrimSpace(req.User) == "" {
		return nil, fail("bad_request", "a check-in needs a comment and a user")
	}
	var parent int64
	tip := ""
	if hasCheckins(r) {
		rid, uuid, err := resolve(r, "")
		if err != nil {
			return nil, err
		}
		parent, tip = rid, uuid
	}
	if req.Parent != "" && (len(req.Parent) < 4 || !strings.HasPrefix(tip, strings.ToLower(req.Parent))) {
		return nil, fail("conflict", "the artifact changed since %s; its tip is now %s", req.Parent, tip)
	}
	var files []libfossil.FileToCommit
	for name, b64 := range req.Files {
		data, err := base64.StdEncoding.DecodeString(b64)
		if err != nil {
			return nil, fail("bad_request", "%s is not base64", name)
		}
		if err := checkStorable(name, data); err != nil {
			return nil, fail("too_large", "%v", err)
		}
		if parent != 0 {
			if cur, err := r.ReadFile(parent, name); err == nil && string(cur) == string(data) {
				continue
			}
		}
		files = append(files, libfossil.FileToCommit{Name: name, Content: data})
	}
	if len(files) == 0 {
		return map[string]any{"tip": tip}, fail("unchanged", "nothing changed: every file matches check-in %s", short(tip))
	}
	_, uuid, err := r.Commit(libfossil.CommitOpts{
		Files: files, Comment: req.Comment, User: req.User, Time: time.Now().UTC(), ParentID: parent,
	})
	if err != nil {
		return nil, err
	}
	return map[string]any{"tip": uuid, "parent": tip}, nil
}

func hasCheckins(r *libfossil.Repo) bool {
	var n int
	_ = r.DB().QueryRow(`SELECT count(*) FROM event WHERE type = 'ci'`).Scan(&n)
	return n > 0
}

func resolve(r *libfossil.Repo, at string) (int64, string, error) {
	if at == "" {
		at = "trunk"
	}
	rid, err := r.ResolveVersion(at)
	if err != nil {
		return 0, "", fail("not_found", "no check-in named %q", at)
	}
	uuid, err := r.UUIDFromRID(rid)
	return rid, uuid, err
}

func tipOf(r *libfossil.Repo, at string) (string, error) {
	if !hasCheckins(r) {
		return "", nil
	}
	_, uuid, err := resolve(r, at)
	return uuid, err
}

func nonNil(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// callEngine handles one request: args[0] the JSON request, args[1] an
// optional body. It returns the JSON reply.
func callEngine(args []js.Value) (out any) {
	aborted = ""
	reply := map[string]any{}
	defer func() {
		if p := recover(); p != nil {
			reply = map[string]any{"error": fmt.Sprintf("panic: %v", p), "code": "internal"}
		}
		if aborted != "" {
			reply["aborted"] = aborted
		}
		j, _ := json.Marshal(reply)
		out = string(j)
	}()
	var req request
	if err := json.Unmarshal([]byte(args[0].String()), &req); err != nil {
		reply["error"], reply["code"] = err.Error(), "bad_request"
		return nil
	}
	var body []byte
	if len(args) > 1 && args[1].Truthy() {
		body = make([]byte, args[1].Get("length").Int())
		js.CopyBytesToGo(body, args[1])
	}
	result, err := handle(req, body)
	if err != nil {
		reply["error"], reply["code"] = err.Error(), "internal"
		if result != nil {
			reply["result"] = result
		}
		var c coded
		if errors.As(err, &c) {
			reply["code"] = c.code
		}
		return nil
	}
	reply["ok"], reply["result"] = true, result
	return nil
}

func main() {
	api := js.Global().Get("Object").New()
	api.Set("call", js.FuncOf(func(_ js.Value, args []js.Value) any { return callEngine(args) }))
	js.Global().Set("fossilDO", api)
	select {}
}
