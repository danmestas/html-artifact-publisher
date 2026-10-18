//go:build js

// Command artifactrepo exposes one in-memory Fossil repository to JavaScript,
// in the browser (the viewer) and in Node (the publish CLI) alike.
//
// An artifact is a .fossil file: each published version is a check-in on
// trunk, a multi-file page is a check-in with several files, and uploads and
// page data are unversioned files. The repository lives in SQLite's memdb
// VFS; open() loads bytes in, export() hands the whole file back out.
//
// Every function is on the global `fossil` object. Functions that return
// bytes return a Uint8Array; everything else returns a JSON string, and a
// failure is always the JSON string {"error": "..."}.
//
// Built from inside a go-libfossil checkout (it uses internal/content); see
// build.sh.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"syscall/js"
	"time"

	libfossil "github.com/danmestas/go-libfossil"
	"github.com/danmestas/go-libfossil/db"
	"github.com/danmestas/go-libfossil/internal/content"
	fsltype "github.com/danmestas/go-libfossil/internal/fsltype"
	"github.com/ncruces/go-sqlite3"
	_ "github.com/ncruces/go-sqlite3/driver"
	"github.com/ncruces/go-sqlite3/ext/serdes"
	"github.com/ncruces/go-sqlite3/vfs/memdb"
)

func init() {
	db.Register(db.DriverConfig{
		Name: "sqlite3",
		BuildDSN: func(path string, pragmas map[string]string) string {
			// The in-memory VFS keeps no journal files; a memory journal suffices.
			keys := make([]string, 0, len(pragmas))
			for k := range pragmas {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			var parts []string
			for _, k := range keys {
				v := pragmas[k]
				if k == "journal_mode" {
					v = "MEMORY"
				}
				parts = append(parts, fmt.Sprintf("_pragma=%s(%s)", k, v))
			}
			return "file:" + path + "?vfs=memdb&" + strings.Join(parts, "&")
		},
	})
}

// The open repository, and a counter so every open gets a fresh memdb name.
var (
	repo *libfossil.Repo
	mem  string
	seq  int
)

type result map[string]any

func fail(err error) any {
	b, _ := json.Marshal(result{"error": err.Error()})
	return string(b)
}

// fn wraps a Go function for JS: a []byte result becomes a Uint8Array,
// anything else is JSON-encoded.
func fn(f func(args []js.Value) (any, error)) js.Func {
	return js.FuncOf(func(_ js.Value, args []js.Value) (out any) {
		defer func() {
			if p := recover(); p != nil {
				out = fail(fmt.Errorf("panic: %v", p))
			}
		}()
		v, err := f(args)
		if err != nil {
			return fail(err)
		}
		if b, ok := v.([]byte); ok {
			u := js.Global().Get("Uint8Array").New(len(b))
			js.CopyBytesToJS(u, b)
			return u
		}
		j, _ := json.Marshal(v)
		return string(j)
	})
}

func arg(args []js.Value, i int) js.Value {
	if i < len(args) {
		return args[i]
	}
	return js.Undefined()
}

func str(v js.Value) string {
	if v.Type() != js.TypeString {
		return ""
	}
	return v.String()
}

func bytesOf(v js.Value) []byte {
	b := make([]byte, v.Get("length").Int())
	js.CopyBytesToGo(b, v)
	return b
}

// load replaces the open repository with one held in memdb under a new name.
func load(data []byte, create func(path string) (*libfossil.Repo, error)) error {
	if repo != nil {
		repo.Close()
		memdb.Delete(mem)
		repo = nil
	}
	seq++
	mem = fmt.Sprintf("artifact-%d.fossil", seq)
	memdb.Create(mem, data)
	r, err := create("/" + mem)
	if err != nil {
		memdb.Delete(mem)
		return err
	}
	repo = r
	return nil
}

func need() error {
	if repo == nil {
		return fmt.Errorf("no repository is open")
	}
	return nil
}

// create(projectName, user) starts an empty repository.
func create(args []js.Value) (any, error) {
	name, user := str(arg(args, 0)), str(arg(args, 1))
	if err := load(nil, func(p string) (*libfossil.Repo, error) {
		return libfossil.Create(p, libfossil.CreateOpts{User: user})
	}); err != nil {
		return nil, err
	}
	if name != "" {
		if err := repo.SetConfig("project-name", name); err != nil {
			return nil, err
		}
	}
	return info()
}

// open(bytes) loads an existing .fossil file.
func open(args []js.Value) (any, error) {
	if err := load(bytesOf(arg(args, 0)), libfossil.Open); err != nil {
		return nil, err
	}
	return info()
}

func info() (any, error) {
	name, _ := repo.Config("project-name")
	code, _ := repo.Config("project-code")
	return result{"projectName": name, "projectCode": code}, nil
}

// resolve turns "" (trunk tip), a branch, a tag or a hash prefix into a rid.
func resolve(at string) (int64, error) {
	if at == "" {
		at = "trunk"
	}
	return repo.ResolveVersion(at)
}

type checkin struct {
	UUID    string   `json:"uuid"`
	Comment string   `json:"comment"`
	User    string   `json:"user"`
	Time    string   `json:"time"`
	Parents []string `json:"parents"`
}

// timeline() lists check-ins newest first.
func timeline(_ []js.Value) (any, error) {
	if err := need(); err != nil {
		return nil, err
	}
	entries, err := repo.Timeline(libfossil.TimelineOpts{Type: libfossil.EventKindCheckin})
	if err != nil {
		return nil, err
	}
	out := make([]checkin, 0, len(entries))
	for _, e := range entries {
		parents := e.Parents
		if parents == nil {
			parents = []string{}
		}
		out = append(out, checkin{e.UUID, e.Comment, e.User, e.Time.UTC().Format(time.RFC3339), parents})
	}
	return out, nil
}

// tip(at) names the check-in `at` resolves to.
func tip(args []js.Value) (any, error) {
	if err := need(); err != nil {
		return nil, err
	}
	rid, err := resolve(str(arg(args, 0)))
	if err != nil {
		return nil, err
	}
	uuid, err := repo.UUIDFromRID(rid)
	if err != nil {
		return nil, err
	}
	return result{"uuid": uuid}, nil
}

// files(at) lists the files of a check-in.
func files(args []js.Value) (any, error) {
	if err := need(); err != nil {
		return nil, err
	}
	rid, err := resolve(str(arg(args, 0)))
	if err != nil {
		return nil, err
	}
	entries, err := repo.ListFiles(rid)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.Name)
	}
	return out, nil
}

// read(path, at) returns one file's bytes at a check-in.
func read(args []js.Value) (any, error) {
	if err := need(); err != nil {
		return nil, err
	}
	rid, err := resolve(str(arg(args, 1)))
	if err != nil {
		return nil, err
	}
	return repo.ReadFile(rid, str(arg(args, 0)))
}

// commit(files, comment, user, parent) checks in on top of `parent` (default
// the trunk tip). files maps path to Uint8Array; paths not named are carried
// forward unchanged. Each changed file's previous version is re-stored as a
// delta against the new one, as `fossil commit` does.
func commit(args []js.Value) (any, error) {
	if err := need(); err != nil {
		return nil, err
	}
	obj, comment, user := arg(args, 0), str(arg(args, 1)), str(arg(args, 2))
	if strings.TrimSpace(comment) == "" || strings.TrimSpace(user) == "" {
		return nil, fmt.Errorf("a check-in needs a comment and a user")
	}
	keys := js.Global().Get("Object").Call("keys", obj)
	var changed []libfossil.FileToCommit
	var parent int64
	if p := str(arg(args, 3)); p != "" || hasCheckin() {
		rid, err := resolve(p)
		if err != nil {
			return nil, err
		}
		parent = rid
	}
	for i := 0; i < keys.Length(); i++ {
		name := keys.Index(i).String()
		data := bytesOf(obj.Get(name))
		if parent != 0 {
			if cur, err := repo.ReadFile(parent, name); err == nil && string(cur) == string(data) {
				continue
			}
		}
		changed = append(changed, libfossil.FileToCommit{Name: name, Content: data})
	}
	if len(changed) == 0 {
		return nil, fmt.Errorf("nothing changed: every file matches the parent check-in")
	}
	old := map[string]int64{}
	if parent != 0 {
		for _, f := range changed {
			old[f.Name] = fileRid(parent, f.Name)
		}
	}
	rid, uuid, err := repo.Commit(libfossil.CommitOpts{
		Files:    changed,
		Comment:  comment,
		User:     user,
		Time:     time.Now().UTC(),
		ParentID: parent,
	})
	if err != nil {
		return nil, err
	}
	saved := 0
	for name, o := range old {
		n := fileRid(rid, name)
		if o == 0 || n == 0 || o == n {
			continue
		}
		if err := repo.WithTx(func(tx *db.Tx) error {
			s, err := content.Deltify(tx, fsltype.FslID(o), fsltype.FslID(n))
			saved += s
			return err
		}); err != nil {
			return nil, fmt.Errorf("deltify: %w", err)
		}
	}
	return result{"uuid": uuid, "saved": saved}, nil
}

func hasCheckin() bool {
	var n int
	_ = repo.DB().QueryRow(`SELECT count(*) FROM event WHERE type = 'ci'`).Scan(&n)
	return n > 0
}

func fileRid(checkin int64, name string) int64 {
	var rid int64
	_ = repo.DB().QueryRow(`SELECT m.fid FROM mlink m JOIN filename f ON f.fnid = m.fnid
		WHERE m.mid = ? AND f.name = ?`, checkin, name).Scan(&rid)
	return rid
}

// leaves() lists the open leaves; more than one means concurrent writers
// forked trunk and the caller should look before committing over them.
func leaves(_ []js.Value) (any, error) {
	if err := need(); err != nil {
		return nil, err
	}
	rows, err := repo.DB().Query(`SELECT b.uuid FROM leaf l JOIN blob b ON b.rid = l.rid
		JOIN event e ON e.objid = l.rid ORDER BY e.mtime DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var u string
		if err := rows.Scan(&u); err != nil {
			return nil, err
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// merge(bytes) takes in every artifact of another copy of the same project.
// Nothing is lost: a concurrent check-in becomes a second leaf.
func merge(args []js.Value) (any, error) {
	if err := need(); err != nil {
		return nil, err
	}
	seq++
	otherMem := fmt.Sprintf("merge-%d.fossil", seq)
	memdb.Create(otherMem, bytesOf(arg(args, 0)))
	defer memdb.Delete(otherMem)
	other, err := libfossil.Open("/" + otherMem)
	if err != nil {
		return nil, err
	}
	defer other.Close()
	code, _ := repo.Config("project-code")
	if c, _ := other.Config("project-code"); c != code {
		return nil, fmt.Errorf("the other repository is a different project")
	}
	t := libfossil.TransportFunc(func(ctx context.Context, p []byte) ([]byte, error) {
		return other.HandleSync(ctx, p)
	})
	if _, err := repo.Sync(context.Background(), t, libfossil.SyncOpts{Pull: true, UV: true, ProjectCode: code}); err != nil {
		return nil, err
	}
	return leaves(nil)
}

// export() returns the whole repository file.
func export(_ []js.Value) (any, error) {
	if err := need(); err != nil {
		return nil, err
	}
	conn, err := repo.DB().SqlDB().Conn(context.Background())
	if err != nil {
		return nil, err
	}
	defer conn.Close()
	var out []byte
	err = conn.Raw(func(dc any) error {
		c, ok := dc.(interface{ Raw() *sqlite3.Conn })
		if !ok {
			return fmt.Errorf("driver connection has no raw SQLite handle")
		}
		out, err = serdes.Serialize(c.Raw(), "main")
		return err
	})
	return out, err
}

// uvWrite(name, bytes) / uvRead(name) / uvList(): unversioned files, for
// uploads and page data that should not grow the history.
func uvWrite(args []js.Value) (any, error) {
	if err := need(); err != nil {
		return nil, err
	}
	return result{"ok": true}, repo.UVWrite(str(arg(args, 0)), bytesOf(arg(args, 1)), time.Now())
}

func uvRead(args []js.Value) (any, error) {
	if err := need(); err != nil {
		return nil, err
	}
	b, _, _, err := repo.UVRead(str(arg(args, 0)))
	return b, err
}

func uvList(_ []js.Value) (any, error) {
	if err := need(); err != nil {
		return nil, err
	}
	entries, err := repo.UVList()
	if err != nil {
		return nil, err
	}
	type uvFile struct {
		Name  string `json:"name"`
		Size  int64  `json:"size"`
		Mtime string `json:"mtime"`
	}
	out := make([]uvFile, 0, len(entries))
	for _, e := range entries {
		out = append(out, uvFile{e.Name, e.Size, e.Mtime.UTC().Format(time.RFC3339)})
	}
	return out, nil
}

func main() {
	api := js.Global().Get("Object").New()
	for name, f := range map[string]func([]js.Value) (any, error){
		"create": create, "open": open, "timeline": timeline, "tip": tip, "files": files,
		"read": read, "commit": commit, "leaves": leaves, "merge": merge, "export": export,
		"uvWrite": uvWrite, "uvRead": uvRead, "uvList": uvList,
	} {
		api.Set(name, fn(f))
	}
	js.Global().Set("fossil", api)
	if cb := js.Global().Get("onFossilReady"); cb.Type() == js.TypeFunction {
		cb.Invoke()
	}
	select {}
}
