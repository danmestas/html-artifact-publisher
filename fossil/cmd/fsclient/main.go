// Command fsclient is a minimal Fossil client for the end-to-end tests: it
// clones a repository over HTTP, and commits and pushes to it, using
// go-libfossil natively.
//
//	fsclient clone <url> <repo.fossil>
//	fsclient push  <repo.fossil> <url> <file> <content|@path> <comment>
//
// URLs carry their login as https://login:password@host/r/<id>.
package main

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	libfossil "github.com/danmestas/go-libfossil"
	_ "github.com/danmestas/go-libfossil/db/driver/modernc"
)

func main() {
	if len(os.Args) < 2 {
		die(fmt.Errorf("usage: fsclient clone|push ..."))
	}
	ctx := context.Background()
	switch os.Args[1] {
	case "clone":
		u, user, pass := login(os.Args[2])
		r, res, err := libfossil.Clone(ctx, os.Args[3], libfossil.NewHTTPTransport(u), libfossil.CloneOpts{User: user, Password: pass})
		die(err)
		defer r.Close()
		fmt.Printf("cloned: %+v\n", *res)
	case "push":
		r, err := libfossil.Open(os.Args[2])
		die(err)
		defer r.Close()
		u, user, pass := login(os.Args[3])
		tip, err := r.ResolveVersion("trunk")
		die(err)
		content := []byte(os.Args[5])
		if p, ok := strings.CutPrefix(os.Args[5], "@"); ok {
			content, err = os.ReadFile(p)
			die(err)
		}
		_, uuid, err := r.Commit(libfossil.CommitOpts{
			Files:   []libfossil.FileToCommit{{Name: os.Args[4], Content: content}},
			Comment: os.Args[6], User: user, Time: time.Now().UTC(), ParentID: tip,
		})
		die(err)
		code, _ := r.Config("project-code")
		res, err := r.Sync(ctx, libfossil.NewHTTPTransport(u), libfossil.SyncOpts{Push: true, Pull: true, User: user, Password: pass, ProjectCode: code})
		die(err)
		if len(res.Errors) > 0 {
			die(fmt.Errorf("sync errors: %v", res.Errors))
		}
		fmt.Printf("pushed %s\n", uuid)
	default:
		die(fmt.Errorf("unknown command %q", os.Args[1]))
	}
}

// login splits the credentials out of a URL.
func login(raw string) (string, string, string) {
	u, err := url.Parse(raw)
	die(err)
	user := u.User.Username()
	pass, _ := u.User.Password()
	u.User = nil
	return u.String(), user, pass
}

func die(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "fsclient:", err)
		os.Exit(1)
	}
}
