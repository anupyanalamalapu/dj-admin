import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it } from "node:test";
import {
  deleteWorkspace,
  getWorkspaceByEventId,
  ingestInquiry,
  listWorkspaces,
} from "../../../lib/admin/orchestration/admin-service";

describe("workspaces list integration", () => {
  it("returns workspace rows for existing events", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    await ingestInquiry({
      messageText:
        "Riya Patel <riya@example.com>\nDate: May 1st, 2027\nLocation: NYC\nServices needed: DJ\nBest,\nRiya",
      uploadedFile: null,
    });

    const rows = await listWorkspaces();
    assert.ok(rows.length >= 1);
    assert.equal(rows[0].clientEmail, "riya@example.com");
    assert.ok(rows[0].eventId);
    assert.equal(typeof rows[0].contractTotalAmount, "number");
    assert.ok(rows[0].lastModifiedAt);
    assert.ok(rows[0].primaryContact);
    assert.ok(rows[0].workspaceTitle);
    assert.ok(typeof rows[0].latestContextSummary === "string");
  });

  it("sorts by most recently modified workspace timestamp descending", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const first = await ingestInquiry({
      messageText:
        "Anjali Trivedi <anjali@example.com>\nDate: May 1st, 2027\nLocation: NYC\nServices needed: DJ\nBest,\nAnjali",
      uploadedFile: null,
    });

    const second = await ingestInquiry({
      messageText:
        "Maya Patel <maya@example.com>\nDate: May 2nd, 2027\nLocation: SF\nServices needed: DJ\nBest,\nMaya",
      uploadedFile: null,
    });

    await ingestInquiry({
      messageText:
        "Anjali Trivedi <anjali@example.com>\nFollowing up with timeline details.\nTime: 5:00 pm - 10:00 pm",
      uploadedFile: null,
    });

    const rows = await listWorkspaces();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].eventId, first.eventId);
    assert.equal(rows[1].eventId, second.eventId);
    assert.ok(new Date(rows[0].lastModifiedAt).getTime() >= new Date(rows[1].lastModifiedAt).getTime());
  });

  it("deletes a workspace and its linked records", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText:
        "Sonia Mehta <sonia@example.com>\nDate: Jun 6th, 2027\nLocation: SF\nServices needed: DJ, MC\nBest,\nSonia",
      uploadedFile: null,
    });

    const beforeRows = await listWorkspaces();
    assert.equal(beforeRows.length, 1);

    const removed = await deleteWorkspace(created.eventId);
    assert.equal(removed, true);

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.equal(workspace, null);

    const afterRows = await listWorkspaces();
    assert.equal(afterRows.length, 0);

    const removedAgain = await deleteWorkspace(created.eventId);
    assert.equal(removedAgain, false);
  });
});
