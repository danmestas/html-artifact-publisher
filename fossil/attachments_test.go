package main

import (
	"encoding/base64"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	libfossil "github.com/danmestas/go-libfossil"
	_ "github.com/danmestas/go-libfossil/db/driver/modernc"
)

func ticketRepo(t *testing.T) (*libfossil.Repo, string) {
	t.Helper()
	r, err := libfossil.Create(filepath.Join(t.TempDir(), "a.fossil"), libfossil.CreateOpts{User: "test"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { r.Close() })
	uuid, _, err := r.TicketAdd(libfossil.TicketOpts{Fields: map[string]string{"title": "t", "status": "Open"}, User: "test"})
	if err != nil {
		t.Fatal(err)
	}
	return r, uuid
}

func listed(t *testing.T, r *libfossil.Repo, target string) []attachmentView {
	t.Helper()
	got, ok, err := attachOp(r, "attachList", attachReq{Target: target})
	if !ok || err != nil {
		t.Fatalf("attachList: ok=%v err=%v", ok, err)
	}
	return got.(map[string]any)["attachments"].([]attachmentView)
}

func TestAttachOpsRegularAndExternal(t *testing.T) {
	r, ticket := ticketRepo(t)
	if _, _, err := attachOp(r, "attachAdd", attachReq{Target: ticket, Name: "notes.txt", User: "comment-link", Content: []byte("hello")}); err != nil {
		t.Fatal(err)
	}
	sha := strings.Repeat("ab", 32)
	if _, _, err := attachOp(r, "attachAddExternal", attachReq{Target: ticket, Name: "shot.png", User: "edit-link", SHA256: sha, Size: 12345, Type: "image/png"}); err != nil {
		t.Fatal(err)
	}

	got := listed(t, r, ticket)
	if len(got) != 2 {
		t.Fatalf("listed %d attachments, want 2: %+v", len(got), got)
	}
	byName := map[string]attachmentView{}
	for _, a := range got {
		byName[a.Name] = a
	}
	if a := byName["notes.txt"]; a.External || a.Size != 5 || a.SHA256 != "" || a.User != "comment-link" {
		t.Errorf("regular attachment listed as %+v", a)
	}
	if a := byName["shot.png"]; !a.External || a.Size != 12345 || a.SHA256 != sha || a.Type != "image/png" || a.User != "edit-link" {
		t.Errorf("external attachment listed as %+v", a)
	}

	read, _, err := attachOp(r, "attachRead", attachReq{Target: ticket, Name: "notes.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if d := read.(attachmentView).Data; d != base64.StdEncoding.EncodeToString([]byte("hello")) {
		t.Errorf("regular read data = %q", d)
	}
	ext, _, err := attachOp(r, "attachRead", attachReq{Target: ticket, Name: "shot.png"})
	if err != nil {
		t.Fatal(err)
	}
	if v := ext.(attachmentView); v.Data != "" || v.SHA256 != sha {
		t.Errorf("external read = %+v, want no data and its sha256", v)
	}
}

func TestAttachOpsDelete(t *testing.T) {
	r, ticket := ticketRepo(t)
	if _, _, err := attachOp(r, "attachAdd", attachReq{Target: ticket, Name: "a.txt", User: "u", Content: []byte("x")}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := attachOp(r, "attachDelete", attachReq{Target: ticket, Name: "a.txt", User: "u"}); err != nil {
		t.Fatal(err)
	}
	if got := listed(t, r, ticket); len(got) != 0 {
		t.Errorf("after delete, listed %+v", got)
	}
	_, _, err := attachOp(r, "attachDelete", attachReq{Target: ticket, Name: "a.txt", User: "u"})
	var c coded
	if !errors.As(err, &c) || c.code != "not_found" {
		t.Errorf("deleting a deleted attachment: %v, want not_found", err)
	}
	_, _, err = attachOp(r, "attachRead", attachReq{Target: ticket, Name: "a.txt"})
	if !errors.As(err, &c) || c.code != "not_found" {
		t.Errorf("reading a deleted attachment: %v, want not_found", err)
	}
}

func TestAttachOpsRefuse(t *testing.T) {
	r, ticket := ticketRepo(t)
	stub := "quarry-attachment 1\nsha256 " + strings.Repeat("cd", 32) + "\nsize 1\ntype text/plain\nname x\n"
	for name, req := range map[string]attachReq{
		"stub as content":   {Target: ticket, Name: "x", User: "u", Content: []byte(stub)},
		"directory in name": {Target: ticket, Name: "a/b.png", User: "u", SHA256: strings.Repeat("ab", 32), Size: 1, Type: "image/png"},
	} {
		op := "attachAdd"
		if req.SHA256 != "" {
			op = "attachAddExternal"
		}
		_, _, err := attachOp(r, op, req)
		var c coded
		if !errors.As(err, &c) || c.code != "bad_request" {
			t.Errorf("%s: %v, want bad_request", name, err)
		}
	}
	if _, ok, _ := attachOp(r, "commit", attachReq{}); ok {
		t.Error("attachOp claimed a non-attachment op")
	}
}

func TestAttachOpsGuard(t *testing.T) {
	r, ticket := ticketRepo(t)
	add := func(name, user, guard string) error {
		_, _, err := attachOp(r, "attachAdd", attachReq{Target: ticket, Name: name, User: user, Guard: guard, Content: []byte(user)})
		return err
	}
	if err := add("ed.txt", "edit-link", ""); err != nil {
		t.Fatal(err)
	}
	if err := add("c.txt", "comment-link", "comment-link"); err != nil {
		t.Fatalf("a guarded add of a new name: %v", err)
	}
	var c coded
	if err := add("ed.txt", "comment-link", "comment-link"); !errors.As(err, &c) || c.code != "forbidden" {
		t.Errorf("a guarded add over another author's attachment: %v, want forbidden", err)
	}
	if err := add("c.txt", "comment-link", "comment-link"); err != nil {
		t.Errorf("a guarded add over its own identity's attachment: %v", err)
	}
	_, _, err := attachOp(r, "attachDelete", attachReq{Target: ticket, Name: "ed.txt", User: "comment-link", Guard: "comment-link"})
	if !errors.As(err, &c) || c.code != "forbidden" {
		t.Errorf("a guarded delete of another author's attachment: %v, want forbidden", err)
	}
	if _, _, err := attachOp(r, "attachDelete", attachReq{Target: ticket, Name: "c.txt", User: "comment-link", Guard: "comment-link"}); err != nil {
		t.Errorf("a guarded delete of its own identity's attachment: %v", err)
	}
	// An unguarded caller (an editor) may replace and delete anything.
	if err := add("ed.txt", "edit-link", ""); err != nil {
		t.Error(err)
	}
	if _, _, err := attachOp(r, "attachDelete", attachReq{Target: ticket, Name: "ed.txt", User: "edit-link"}); err != nil {
		t.Error(err)
	}
}

func TestAttachOpsMaxCount(t *testing.T) {
	r, ticket := ticketRepo(t)
	other, _, err := r.TicketAdd(libfossil.TicketOpts{Fields: map[string]string{"title": "u", "status": "Open"}, User: "test"})
	if err != nil {
		t.Fatal(err)
	}
	add := func(target, name string) error {
		_, _, err := attachOp(r, "attachAdd", attachReq{Target: target, Name: name, User: "u", Content: []byte(name), MaxCount: 2})
		return err
	}
	if err := add(ticket, "a.txt"); err != nil {
		t.Fatal(err)
	}
	if err := add(other, "b.txt"); err != nil {
		t.Fatal(err)
	}
	var c coded
	if err := add(ticket, "c.txt"); !errors.As(err, &c) || c.code != "quota" {
		t.Errorf("a third attachment across threads: %v, want quota", err)
	}
	if err := add(ticket, "a.txt"); err != nil {
		t.Errorf("replacing an attachment adds none: %v", err)
	}
	if _, _, err := attachOp(r, "attachDelete", attachReq{Target: ticket, Name: "a.txt", User: "u"}); err != nil {
		t.Fatal(err)
	}
	if err := add(ticket, "c.txt"); err != nil {
		t.Errorf("after a delete there is room again: %v", err)
	}
	_, _, err = attachOp(r, "attachAddExternal", attachReq{Target: ticket, Name: "d.png", User: "u", SHA256: strings.Repeat("ab", 32), Size: 1, Type: "image/png", MaxCount: 2})
	if !errors.As(err, &c) || c.code != "quota" {
		t.Errorf("an external attachment over the count: %v, want quota", err)
	}
}
