//go:build js

package main

import (
	"time"

	libfossil "github.com/danmestas/go-libfossil"
)

// maxThreads bounds ticketThreads; the Worker validates limit to the same range.
const maxThreads = 200

// thread is a ticket with its changes, oldest first.
type thread struct {
	libfossil.Ticket
	Changes []libfossil.TicketChange `json:"changes"`
}

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

	case "ticketThreads":
		// One call for the whole comment view, so its cost does not grow with
		// a request per ticket: the limit most recently changed, and whether
		// there are more.
		if req.Limit < 1 || req.Limit > maxThreads {
			return nil, true, fail("bad_request", "limit must be 1 to %d", maxThreads)
		}
		tickets, err := r.TicketList()
		if err != nil {
			return nil, true, err
		}
		truncated := len(tickets) > req.Limit
		if truncated {
			tickets = tickets[:req.Limit]
		}
		threads := make([]thread, len(tickets))
		for i, t := range tickets {
			changes, err := r.TicketChanges(t.UUID)
			if err != nil {
				return nil, true, err
			}
			threads[i] = thread{Ticket: t, Changes: changes}
		}
		return map[string]any{"tickets": threads, "truncated": truncated, "limit": req.Limit}, true, nil

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
