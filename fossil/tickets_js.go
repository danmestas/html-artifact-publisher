//go:build js

package main

import (
	"time"

	libfossil "github.com/danmestas/go-libfossil"
)

// ticketOp handles the ticket and timeline ops; ok is false for any other op.
// A reader comment is a Fossil ticket: ticketAdd opens a thread, ticketSet
// replies to or resolves one, and the reads return plain JSON values.
func ticketOp(r *libfossil.Repo, req request) (result any, ok bool, err error) {
	opts := libfossil.TicketOpts{Fields: req.Fields, User: req.User, Comment: req.Comment}
	switch req.Op {
	case "ticketAdd":
		uuid, artifact, err := r.TicketAdd(opts)
		if err != nil {
			return nil, true, fail("bad_request", "%v", err)
		}
		return map[string]any{"ticketUuid": uuid, "artifact": artifact}, true, nil

	case "ticketSet":
		artifact, err := r.TicketSet(req.TicketUUID, opts)
		if err != nil {
			return nil, true, fail("bad_request", "%v", err)
		}
		return map[string]any{"artifact": artifact}, true, nil

	case "ticketList":
		tickets, err := r.TicketList()
		return tickets, true, err

	case "ticketChanges":
		changes, err := r.TicketChanges(req.TicketUUID)
		if err != nil {
			return nil, true, fail("not_found", "%v", err)
		}
		return changes, true, nil

	case "timelineSince":
		kinds := make([]libfossil.EventKind, len(req.Types))
		for i, k := range req.Types {
			kinds[i] = libfossil.EventKind(k)
		}
		entries, err := r.TimelineSince(req.Hash, kinds...)
		if err != nil {
			return nil, true, fail("bad_request", "%v", err)
		}
		timeline := make([]map[string]any, 0, len(entries))
		for _, e := range entries {
			timeline = append(timeline, map[string]any{
				"uuid": e.UUID, "type": string(e.Kind), "comment": e.Comment, "user": e.User,
				"time": e.Time.UTC().Format(time.RFC3339), "parents": nonNil(e.Parents),
			})
		}
		return timeline, true, nil
	}
	return nil, false, nil
}
