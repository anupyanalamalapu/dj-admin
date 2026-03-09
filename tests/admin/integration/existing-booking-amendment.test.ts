import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it } from "node:test";
import { ingestInquiry, getWorkspaceByEventId, updateWorkspace } from "../../../lib/admin/orchestration/admin-service";

describe("existing booking amendment integration", () => {
  it("suggests amendments for follow-up after contract approval + deposit", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    const nearDate = new Date();
    nearDate.setDate(nearDate.getDate() + 10);
    const nearIsoDate = nearDate.toISOString().slice(0, 10);

    const initial = await ingestInquiry({
      messageText:
        `Hi this is Shohini. Email: shohini@example.com. Wedding event on ${nearIsoDate} at DC. Need DJ services.`,
      uploadedFile: null,
    });

    const initialWorkspace = await getWorkspaceByEventId(initial.eventId);
    assert.ok(initialWorkspace?.contract);

    await updateWorkspace({
      eventId: initial.eventId,
      contractFields: initialWorkspace!.contract!.dynamicFields,
      approveContract: true,
    });
    await updateWorkspace({
      eventId: initial.eventId,
      signedContract: true,
    });
    await updateWorkspace({
      eventId: initial.eventId,
      markDepositReceived: true,
    });

    await ingestInquiry({
      messageText:
        `Following up from shohini@example.com for ${nearIsoDate} DC event. Please add Haldi and adjust Friday timing plus travel.`,
      uploadedFile: null,
    });

    const finalWorkspace = await getWorkspaceByEventId(initial.eventId);
    assert.equal(finalWorkspace?.event.stage, "execution");
    assert.ok(finalWorkspace?.event.amendmentSuggestion);
    assert.match(finalWorkspace?.event.amendmentSuggestion || "", /Suggested amendment/i);
  });
});
