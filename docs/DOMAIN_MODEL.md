# Domain Model

## Core Entities

- `Client`
  - Identity/contact record (name, email, phone, Instagram, location).
- `Event`
  - Workspace anchor object (event date bounds, stage, status, service requirements, links to other records).
- `Inquiry`
  - Raw/processed context from pasted text or file upload.
- `Contract`
  - Generated/approved contract versions and dynamic event rows.
- `Invoice`
  - Payment totals/status linked to an event.
- `Document`
  - Uploaded artifacts (signed contracts, proofs, files).
- `Communication`
  - Draft and approved outbound message history.

## Relationship Summary

- One `Client` can have many `Event`s.
- One `Event` can have many `Inquiry`, `Contract`, `Document`, `Communication` records.
- An `Invoice` is tied to one `Event` (current model).

## Workspace Snapshot

`WorkspaceSnapshot` is the aggregated view used by the workspace UI. It merges:

- client
- event
- latest contract version
- invoice
- related documents
- related inquiries
- communications

This snapshot is read from domain services and should be treated as the source for UI rendering.
