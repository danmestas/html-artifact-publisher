package main

import (
	"encoding/base64"
	"errors"
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
		artifact, err := r.AttachmentAdd(a.Target, a.Name, a.Content, opts)
		if err != nil {
			return nil, true, fail("bad_request", "%v", err)
		}
		return map[string]any{"artifact": artifact}, true, nil

	case "attachAddExternal":
		ref := libfossil.ExternalRef{SHA256: a.SHA256, Size: a.Size, Type: a.Type, Name: a.Name}
		artifact, err := r.AttachmentAddExternal(a.Target, ref, opts)
		if err != nil {
			return nil, true, fail("bad_request", "%v", err)
		}
		return map[string]any{"artifact": artifact}, true, nil

	case "attachDelete":
		opts.Comment = "" // fossil writes none on a deletion
		artifact, err := r.AttachmentDelete(a.Target, a.Name, opts)
		if err != nil {
			return nil, true, notFoundOr(err)
		}
		return map[string]any{"artifact": artifact}, true, nil
	}
	return nil, false, nil
}

func notFoundOr(err error) error {
	if errors.Is(err, libfossil.ErrAttachmentNotFound) {
		return fail("not_found", "%v", err)
	}
	return fail("bad_request", "%v", err)
}
