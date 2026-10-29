package main

import (
	"encoding/base64"
	"errors"
	"sort"
	"time"

	libfossil "github.com/danmestas/go-libfossil"
)

// attachReq is what the attachment ops read from a request.
type attachReq struct {
	Target  string // a ticket's id or a unique prefix of it
	Name    string
	User    string
	Comment string
	Content []byte // attachAdd: the file itself
	SHA256  string // attachAddExternal: the bytes the Worker keeps in R2
	Size    int64
	Type    string
	// Guard, when set, is the only author whose current attachment by Name
	// the change may replace or delete: a comment link changes only what
	// comment links attached.
	Guard string
	// MaxCount, when positive, caps the repository's current attachments
	// across every thread; replacing one by name adds none.
	MaxCount int
}

// attachmentView is one current attachment as the Worker sees it. A regular
// attachment's bytes are in this repository (Data, on a read); an external
// one names bytes the Worker keeps at attachments/<SHA256> in R2.
type attachmentView struct {
	Name     string `json:"name"`
	Size     int64  `json:"size"`
	External bool   `json:"external"`
	SHA256   string `json:"sha256,omitempty"`
	Type     string `json:"type,omitempty"` // external only: a regular attachment carries none
	User     string `json:"user"`
	Time     string `json:"time"`
	Comment  string `json:"comment"`
	Data     string `json:"data,omitempty"` // attachRead of a regular attachment: base64
}

func viewOf(a libfossil.Attachment) attachmentView {
	v := attachmentView{
		Name: a.Name, Size: a.Size, User: a.User, Comment: a.Comment,
		Time: a.Time.UTC().Format(time.RFC3339),
	}
	if a.External != nil {
		v.External, v.SHA256, v.Type = true, a.External.SHA256, a.External.Type
	}
	return v
}

// attachOp handles the attachment ops; ok is false for any other op.
func attachOp(r *libfossil.Repo, op string, a attachReq) (result any, ok bool, err error) {
	opts := libfossil.AttachmentOpts{User: a.User, Comment: a.Comment}
	switch op {
	case "attachList":
		list, err := r.Attachments(a.Target)
		if err != nil {
			return nil, true, fail("not_found", "%v", err)
		}
		views := make([]attachmentView, len(list))
		for i, at := range list {
			views[i] = viewOf(at)
		}
		return map[string]any{"attachments": views}, true, nil

	case "attachRead":
		at, content, err := r.AttachmentRead(a.Target, a.Name)
		if err != nil {
			return nil, true, notFoundOr(err)
		}
		v := viewOf(at)
		if at.External == nil {
			v.Data = base64.StdEncoding.EncodeToString(content)
		}
		return v, true, nil

	case "attachAdd":
		if err := checkStorable(a.Name, a.Content); err != nil {
			return nil, true, fail("too_large", "%v", err)
		}
		if err := checkAdd(r, a); err != nil {
			return nil, true, err
		}
		artifact, err := r.AttachmentAdd(a.Target, a.Name, a.Content, opts)
		if err != nil {
			return nil, true, fail("bad_request", "%v", err)
		}
		return map[string]any{"artifact": artifact}, true, nil

	case "attachAddExternal":
		if err := checkAdd(r, a); err != nil {
			return nil, true, err
		}
		ref := libfossil.ExternalRef{SHA256: a.SHA256, Size: a.Size, Type: a.Type, Name: a.Name}
		artifact, err := r.AttachmentAddExternal(a.Target, ref, opts)
		if err != nil {
			return nil, true, fail("bad_request", "%v", err)
		}
		return map[string]any{"artifact": artifact}, true, nil

	case "attachExternals":
		// The R2 bytes the repository's current attachments name, across every
		// thread, sorted and distinct: what the Worker must keep and count.
		rows, err := r.DB().Query("SELECT DISTINCT target FROM attachment WHERE isLatest AND coalesce(src,'') != ''")
		if err != nil {
			return nil, true, err
		}
		var targets []string
		for rows.Next() {
			var t string
			if err := rows.Scan(&t); err != nil {
				rows.Close()
				return nil, true, err
			}
			targets = append(targets, t)
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			return nil, true, err
		}
		seen := map[string]bool{}
		shas := []string{}
		for _, t := range targets {
			list, err := r.Attachments(t)
			if err != nil {
				return nil, true, err
			}
			for _, at := range list {
				if at.External != nil && !seen[at.External.SHA256] {
					seen[at.External.SHA256] = true
					shas = append(shas, at.External.SHA256)
				}
			}
		}
		sort.Strings(shas)
		return map[string]any{"sha256": shas}, true, nil

	case "attachDelete":
		opts.Comment = "" // fossil writes none on a deletion
		cur, found, err := current(r, a.Target, a.Name)
		if err != nil {
			return nil, true, err
		}
		if found && a.Guard != "" && cur.User != a.Guard {
			return nil, true, fail("forbidden", "%s was attached by %s; this link can remove only what comment links attached", a.Name, cur.User)
		}
		artifact, err := r.AttachmentDelete(a.Target, a.Name, opts)
		if err != nil {
			return nil, true, notFoundOr(err)
		}
		return map[string]any{"artifact": artifact}, true, nil
	}
	return nil, false, nil
}

// current is target's current attachment by name, if any.
func current(r *libfossil.Repo, target, name string) (libfossil.Attachment, bool, error) {
	list, err := r.Attachments(target)
	if err != nil {
		return libfossil.Attachment{}, false, fail("not_found", "%v", err)
	}
	for _, at := range list {
		if at.Name == name {
			return at, true, nil
		}
	}
	return libfossil.Attachment{}, false, nil
}

// checkAdd enforces a.Guard and a.MaxCount for an attachment about to be added.
func checkAdd(r *libfossil.Repo, a attachReq) error {
	cur, found, err := current(r, a.Target, a.Name)
	if err != nil {
		return err
	}
	if found && a.Guard != "" && cur.User != a.Guard {
		return fail("forbidden", "%s was attached by %s; this link can replace only what comment links attached", a.Name, cur.User)
	}
	if found || a.MaxCount <= 0 {
		return nil
	}
	var n int
	if err := r.DB().QueryRow("SELECT count(*) FROM attachment WHERE isLatest AND coalesce(src,'') != ''").Scan(&n); err != nil {
		return err
	}
	if n >= a.MaxCount {
		return fail("quota", "this artifact already has %d attachments, the most it may hold", n)
	}
	return nil
}

func notFoundOr(err error) error {
	if errors.Is(err, libfossil.ErrAttachmentNotFound) {
		return fail("not_found", "%v", err)
	}
	return fail("bad_request", "%v", err)
}
