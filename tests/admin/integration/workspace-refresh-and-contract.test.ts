import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it } from "node:test";
import {
  getWorkspaceByEventId,
  ingestInquiry,
  updateWorkspace,
  uploadWorkspaceChecklistProof,
} from "../../../lib/admin/orchestration/admin-service";
import { readStore, writeStore } from "../../../lib/admin/persistence/store";
import { timestampToIsoDate } from "../../../lib/admin/utils/date";

describe("workspace refresh and contract template integration", () => {
  it("keeps extracted inquiry text, asks timing follow-up, and uses static contract wording", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const result = await ingestInquiry({
      messageText:
        "Hi, this is Maya Patel. Email: maya@example.com. Wedding on 2027-05-23 at The Rockleigh. Need DJ and MC.",
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(result.eventId);
    assert.ok(workspace);
    assert.match(workspace!.event.latestOcrText, /maya@example\.com/i);
    assert.ok(workspace!.event.latestInquirySummary);
    assert.match(workspace!.event.latestDraftEmail.toLowerCase(), /(timeline|time stamps|start.*end)/);
    assert.match(workspace!.event.latestDraftEmail, /\$600\/hour/);
    assert.ok(workspace!.contract);
    assert.match(workspace!.contract!.renderedText, /DJ Wedding Contract/);
    assert.match(workspace!.contract!.renderedText, /custom musical entertainment/i);
    assert.equal(workspace!.contract!.dynamicFields.dueDate, "2027-05-23");
    assert.equal(workspace!.contract!.dynamicFields.cancellationDate, "2026-11-23");
  });

  it("uses a casual availability + quote block format when contract-ready details are complete", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText:
        "Taylor Robinson <tjrobinson@createcultivate.com>\nEvent type: Event\nDate: March 8, 2026\nLocation: NYC\nTime: 1:00 pm - 3:00 pm\nServices needed: DJ",
      uploadedFile: null,
    });

    await updateWorkspace({
      eventId: created.eventId,
      regenerateDraftEmail: true,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    const draft = workspace!.event.latestDraftEmail || "";

    assert.match(draft, /Thank you for reaching out!/i);
    assert.match(draft, /I am available on that date and would love to DJ this event/i);
    assert.match(draft, /My quote for this would be as follows:/i);
    assert.match(draft, /Event:\s*Event/i);
    assert.match(draft, /Date:\s*March 8, 2026\s*·\s*1:00 pm - 3:00 pm/i);
    assert.match(draft, /Billable Hours:\s*2 hours/i);
    assert.match(draft, /Event Total:\s*\$1,800/i);
    assert.match(draft, /Total for DJ services:\s*\$1,800/i);
    assert.match(draft, /jump on a call/i);
  });

  it("refreshes contract dynamic fields from new inquiry processing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const first = await ingestInquiry({
      messageText:
        "Anjali Trivedi <anjali@example.com>\nEvent type: Wedding\nDate: May 23rd, 2027\nLocation: The Rockleigh, New Jersey\nTime: 5:00 pm - 10:00 pm\nServices needed: DJ, MC\nBest,\nAnjali Trivedi",
      uploadedFile: null,
    });

    await ingestInquiry({
      messageText:
        "Anjali Trivedi <anjali@example.com>\nUpdated details for the same booking.\nEvent type: Wedding Reception\nDate: May 24th, 2027\nLocation: Park Chateau, New Jersey\nTime: 6:00 pm - 11:00 pm\nServices needed: DJ, MC, lighting\nBest,\nAnjali Trivedi",
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(first.eventId);
    assert.ok(workspace?.contract);

    const row = workspace!.contract!.dynamicFields.eventDetails[0];
    assert.equal(row.title, "Wedding");
    assert.equal(row.date, "2027-05-24");
    assert.equal(row.location, "Park Chateau, New Jersey");
    assert.equal(row.time, "6:00 pm - 11:00 pm");
    assert.equal(row.amount, 3600);
    assert.equal(workspace!.contract!.dynamicFields.dueDate, "2027-05-24");
    assert.equal(workspace!.contract!.dynamicFields.cancellationDate, "2026-11-24");
    assert.match(workspace!.event.latestOcrText, /----- New (Inquiry|Context) -----/);
  });

  it("updates context summary when workspace fields are edited", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText:
        "Maya Patel <maya@example.com>\nEvent type: Wedding\nDate: May 23rd, 2027\nLocation: NYC\nServices needed: DJ",
      uploadedFile: null,
    });

    const initial = await getWorkspaceByEventId(created.eventId);
    assert.ok(initial);
    assert.match(initial!.event.latestInquirySummary || "", /venue NYC/i);

    const updated = await updateWorkspace({
      eventId: created.eventId,
      workspaceMeta: {
        venue: "Newark, New Jersey",
      },
    });

    assert.ok(updated);
    assert.match(updated!.event.latestInquirySummary || "", /venue Newark, New Jersey/i);
  });

  it("uses workspace profile date bounds as source-of-truth and propagates dates to contract fields", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Ethan and Gaby <ethanandgab@gmail.com>
Hi! We are exploring DJ options for a party on May 1st in NYC.
Would you be around from 7:30-10:30 on that night?`,
      uploadedFile: null,
    });

    const initial = await getWorkspaceByEventId(created.eventId);
    assert.ok(initial);
    assert.ok(initial!.event.eventDate);

    const canonicalDate = initial!.event.eventDate!;
    const startTs = new Date(`${canonicalDate}T19:30:00`).getTime();
    const endTs = new Date(`${canonicalDate}T22:30:00`).getTime();
    assert.ok(Number.isFinite(startTs));
    assert.ok(Number.isFinite(endTs));

    const updated = await updateWorkspace({
      eventId: created.eventId,
      workspaceMeta: {
        workspaceStartTimestamp: startTs,
        workspaceEndTimestamp: endTs,
      },
      reanalyzeFromRaw: true,
    });

    assert.ok(updated?.contract);
    assert.equal(updated!.event.eventDate, canonicalDate);
    assert.equal(updated!.event.eventDateTimestamp, new Date(`${canonicalDate}T00:00:00`).getTime());
    assert.equal(updated!.event.workspaceStartTimestamp, startTs);
    assert.equal(updated!.event.workspaceEndTimestamp, endTs);
    assert.ok(updated!.contract!.dynamicFields.eventDetails.length > 0);
    for (const row of updated!.contract!.dynamicFields.eventDetails) {
      assert.equal(row.date, canonicalDate);
    }
    assert.equal(updated!.contract!.dynamicFields.dueDate, canonicalDate);
  });

  it("keeps manually saved date bounds until new context explicitly contradicts with a year", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const currentYear = new Date().getFullYear();
    const created = await ingestInquiry({
      messageText: `Ethan <ethan@example.com>
Hi, we are planning a party on May 1 in NYC.
Could you share pricing?`,
      uploadedFile: null,
    });

    let workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    assert.equal(workspace!.event.eventDate, `${currentYear}-05-01`);

    const manualYear = currentYear + 1;
    const manualStartTs = new Date(`${manualYear}-05-01T00:00:00`).getTime();
    const manualEndTs = new Date(`${manualYear}-05-01T23:59:59.999`).getTime();

    await updateWorkspace({
      eventId: created.eventId,
      workspaceMeta: {
        workspaceStartTimestamp: manualStartTs,
        workspaceEndTimestamp: manualEndTs,
      },
    });

    workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    assert.equal(workspace!.event.eventDate, `${manualYear}-05-01`);
    assert.equal(timestampToIsoDate(workspace!.event.workspaceStartTimestamp), `${manualYear}-05-01`);

    await ingestInquiry({
      messageText: `Ethan <ethan@example.com>
Following up for May 1 in NYC. Still interested in moving forward.`,
      uploadedFile: null,
    });

    workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    assert.equal(workspace!.event.eventDate, `${manualYear}-05-01`);
    assert.equal(timestampToIsoDate(workspace!.event.workspaceStartTimestamp), `${manualYear}-05-01`);

    const contradictionYear = manualYear + 1;
    await ingestInquiry({
      messageText: `Ethan <ethan@example.com>
Updated details: the event date is May 1, ${contradictionYear} in NYC.`,
      uploadedFile: null,
    });

    workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    assert.equal(workspace!.event.eventDate, `${contradictionYear}-05-01`);
    assert.equal(timestampToIsoDate(workspace!.event.workspaceStartTimestamp), `${contradictionYear}-05-01`);
  });

  it("re-analyzes approved raw feed edits into updated draft and contract", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const first = await ingestInquiry({
      messageText:
        "Priya Shah <priya@example.com>\nEvent type: Wedding\nDate: June 2nd, 2027\nLocation: Legacy Castle, New Jersey\nServices needed: DJ, MC\nBest,\nPriya Shah",
      uploadedFile: null,
    });

    const before = await getWorkspaceByEventId(first.eventId);
    assert.ok(before);
    assert.match(before!.event.latestDraftEmail.toLowerCase(), /(timeline|time stamps|start.*end)/);

    const editedRaw = `${before!.event.latestOcrText}\n\nTime: 4:00 pm - 10:00 pm`;
    const updated = await updateWorkspace({
      eventId: first.eventId,
      ocrText: editedRaw,
      reanalyzeFromRaw: true,
    });

    assert.ok(updated?.contract);
    assert.equal(updated!.contract!.dynamicFields.eventDetails[0].time, "4:00 pm - 10:00 pm");
    assert.equal(updated!.contract!.dynamicFields.eventDetails[0].amount, 4200);
    assert.ok(updated!.event.latestInquirySummary);
    assert.doesNotMatch(updated!.event.latestDraftEmail.toLowerCase(), /(timeline|time stamps|start.*end)/);
  });

  it("auto-captures approved draft email/contract into training data and raw workspace context", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText:
        "Nina Rao <nina@example.com>\nEvent type: Wedding\nDate: October 20, 2027\nLocation: NYC\nTime: 5:00 pm - 9:00 pm\nServices needed: DJ",
      uploadedFile: null,
    });

    const initial = await getWorkspaceByEventId(created.eventId);
    assert.ok(initial?.contract);

    const afterDraftApprove = await updateWorkspace({
      eventId: created.eventId,
      approveDraftEmail: true,
    });
    assert.ok(afterDraftApprove);
    assert.match(afterDraftApprove!.event.latestOcrText, /Workspace Context: Approved Draft Email/i);
    assert.match(afterDraftApprove!.event.latestOcrText, /Best,\s*\nAnupya/i);

    const afterContractApprove = await updateWorkspace({
      eventId: created.eventId,
      approveContractFields: true,
    });
    assert.ok(afterContractApprove);
    assert.match(afterContractApprove!.event.latestOcrText, /Workspace Context: Approved Contract/i);

    await updateWorkspace({
      eventId: created.eventId,
      approveContract: true,
    });

    const store = await readStore();
    const approvedDraftExamples = store.trainingExamples.filter(
      (example) => example.eventId === created.eventId && example.artifactType === "draft_email" && example.decision === "approved"
    );
    const approvedContractExamples = store.trainingExamples.filter(
      (example) => example.eventId === created.eventId && example.artifactType === "contract" && example.decision === "approved"
    );

    assert.equal(approvedDraftExamples.length, 1);
    assert.equal(approvedContractExamples.length, 1);
  });

  it("shows a hold notice for 2 days when no new context exists after an approved draft email", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Leah Kim <leah@example.com>
Event type: Wedding
Date: October 20, 2027
Location: NYC
Time: 5:00 pm - 9:00 pm
Services needed: DJ`,
      uploadedFile: null,
    });

    await updateWorkspace({
      eventId: created.eventId,
      emailDraft: `Hey Leah,\n\nThanks again! Let me know what timeline details you prefer.\n\nBest,\nAnupya`,
      approveDraftEmail: true,
    });

    const refreshed = await updateWorkspace({
      eventId: created.eventId,
      reanalyzeFromRaw: true,
    });

    assert.ok(refreshed);
    assert.match(refreshed!.event.latestOcrText, /Workspace Context: Approved Draft Email/i);
    assert.match(refreshed!.event.latestDraftEmail, /No need to follow up yet, give the client some time\./i);
  });

  it("regenerate keeps the 2-day hold notice when no new client context was added", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Leah Kim <leah@example.com>
Event type: Wedding
Date: October 20, 2027
Location: NYC
Time: 5:00 pm - 9:00 pm
Services needed: DJ`,
      uploadedFile: null,
    });

    await updateWorkspace({
      eventId: created.eventId,
      emailDraft: `Hey Leah,\n\nThanks again! Let me know what timeline details you prefer.\n\nBest,\nAnupya`,
      approveDraftEmail: true,
    });

    const regenerated = await updateWorkspace({
      eventId: created.eventId,
      regenerateDraftEmail: true,
    });

    assert.ok(regenerated);
    assert.match(regenerated!.event.latestDraftEmail, /No need to follow up yet, give the client some time\./i);
  });

  it("after 2 days with no new context, replaces hold notice with a follow-up draft", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Leah Kim <leah@example.com>
Event type: Wedding
Date: October 20, 2027
Location: NYC
Time: 5:00 pm - 9:00 pm
Services needed: DJ`,
      uploadedFile: null,
    });

    await updateWorkspace({
      eventId: created.eventId,
      emailDraft: `Hey Leah,\n\nThanks again! Let me know what timeline details you prefer.\n\nBest,\nAnupya`,
      approveDraftEmail: true,
    });

    const store = await readStore();
    const event = store.events.find((item) => item.id === created.eventId);
    assert.ok(event);
    event!.lastApprovedDraftAt = new Date(Date.now() - (2 * 24 * 60 * 60 * 1000 + 60 * 60 * 1000)).toISOString();
    await writeStore(store);

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    assert.doesNotMatch(workspace!.event.latestDraftEmail, /No need to follow up yet, give the client some time\./i);
    assert.match(workspace!.event.latestDraftEmail.toLowerCase(), /checking in/);
    assert.match(workspace!.event.latestDraftEmail.toLowerCase(), /need anything else/);
  });

  it("uses stage-driven draft behavior for cancelled and operational stages", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Leah Kim <leah@example.com>
Event type: Wedding
Date: September 1, 2027
Location: NYC
Services needed: DJ`,
      uploadedFile: null,
    });

    const cancelled = await updateWorkspace({
      eventId: created.eventId,
      workspaceMeta: { stage: "cancelled" },
      regenerateDraftEmail: true,
    });
    assert.ok(cancelled);
    assert.equal(cancelled!.event.latestDraftEmail, "Good effort, add context if they change their minds!");

    const inContract = await updateWorkspace({
      eventId: created.eventId,
      workspaceMeta: { stage: "in_contract" },
      regenerateDraftEmail: true,
    });
    assert.ok(inContract);
    assert.match(inContract!.event.latestDraftEmail.toLowerCase(), /(travel|logistics)/);

    const withTravelContext = `${inContract!.event.latestOcrText}\n\nTravel and accommodation are confirmed.`;
    const execution = await updateWorkspace({
      eventId: created.eventId,
      workspaceMeta: { stage: "execution" },
      ocrText: withTravelContext,
      reanalyzeFromRaw: true,
    });
    assert.ok(execution);
    assert.match(execution!.event.latestDraftEmail.toLowerCase(), /(playlist|vibe)/);

    const withPlaylistContext = `${execution!.event.latestOcrText}\n\nPlaylists and vibe notes per event are finalized.`;
    const completed = await updateWorkspace({
      eventId: created.eventId,
      workspaceMeta: { stage: "completed" },
      ocrText: withPlaylistContext,
      reanalyzeFromRaw: true,
    });
    assert.ok(completed);
    assert.match(completed!.event.latestDraftEmail.toLowerCase(), /call/);
  });

  it("maps follow-up by client name to existing workspace and appends raw feed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const first = await ingestInquiry({
      messageText: `Anjali Trivedi <anjali@example.com>
Event type: Wedding
Date: May 23rd, 2027
Location: The Rockleigh, New Jersey
Services needed: DJ, MC
Best,
Anjali Trivedi`,
      uploadedFile: null,
    });

    const followUp = await ingestInquiry({
      messageText: `anjali parth
Hey, thanks for getting back to me!

I’d love to hop on a call and chat more. The timeline for the wedding is -
9:00-10:00am Barat
10:00-12:00pm Wedding Ceremony
6:00-7:30pm Cocktail Hour
7:30-11:30pm Reception

I’m definitely interested in learning about pricing for dhol players & emcee services.
What’s included in the $7,000-$8,000 pricing?

Thanks in advance,
Anjali Trivedi`,
      uploadedFile: null,
    });

    assert.equal(followUp.eventId, first.eventId);

    const workspace = await getWorkspaceByEventId(first.eventId);
    assert.ok(workspace);
    assert.match(workspace!.event.latestOcrText, /----- New (Inquiry|Context) -----/);
    assert.match(workspace!.event.latestOcrText, /Thanks in advance,\s*Anjali Trivedi/i);
    assert.ok(workspace!.event.servicesRequested.includes("dhol"));
    assert.ok(workspace!.event.servicesRequested.includes("mc"));
    assert.equal(workspace!.event.venue, "The Rockleigh, New Jersey");
    assert.match(workspace!.event.latestDraftEmail, /(finalize your quote|quote range|pricing|event total|total for dj services)/i);
    assert.match(workspace!.event.latestDraftEmail, /(coordinate add-ons|coordinate|event total|total for dj services)/i);
    assert.match(workspace!.event.latestDraftEmail, /hop on a call|call and talk|set up a call|time windows|jump on a call/i);

    assert.ok(workspace!.contract);
    const rows = workspace!.contract!.dynamicFields.eventDetails;
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.map((row) => row.title),
      ["Barat", "Wedding Ceremony", "Cocktail Hour", "Reception"]
    );
    assert.deepEqual(
      rows.map((row) => row.amount),
      [1200, 1800, 1500, 3000]
    );
    assert.ok(rows.every((row) => row.location === "The Rockleigh, New Jersey"));
  });

  it("fully refreshes an existing workspace from new context even when stage is execution", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Anjali Trivedi <anjali@example.com>
Event type: Wedding
Date: May 23rd, 2027
Location: The Rockleigh, New Jersey
Time: 6:00 pm - 10:00 pm
Services needed: DJ`,
      uploadedFile: null,
    });

    await updateWorkspace({
      eventId: created.eventId,
      workspaceMeta: { stage: "execution" },
    });

    await ingestInquiry({
      messageText: `Anjali Trivedi <anjali@example.com>
Quick update for the same booking:
Location: Park Chateau, New Jersey
Reception - 7:00 pm - 11:30 pm
Could we also align travel and logistics notes this week?`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace?.contract);
    const firstRow = workspace!.contract!.dynamicFields.eventDetails[0];
    assert.equal(firstRow.location, "Park Chateau, New Jersey");
    assert.match((firstRow.time || "").replace(/\s+/g, "").toLowerCase(), /^7:00pm-11:30pm$/);
    assert.match((workspace!.event.latestInquirySummary || "").toLowerCase(), /park chateau/);
    assert.match((workspace!.event.latestDraftEmail || "").toLowerCase(), /(travel|logistics|playlist|vibe|call)/);
  });

  it("responds to call-scheduling actions in follow-ups without repeating previously shared general quote copy", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Anjali Trivedi <anjali@example.com>
Event type: Wedding
Date: May 23rd, 2027
Location: The Rockleigh, New Jersey
Services needed: DJ, MC`,
      uploadedFile: null,
    });

    await updateWorkspace({
      eventId: created.eventId,
      approveDraftEmail: true,
    });

    await ingestInquiry({
      messageText: `Anjali Trivedi <anjali@example.com>
Thanks for sharing that. I'd love to schedule a call to go over details this week.
Can you send over some times that work for you?`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    assert.match(workspace!.event.latestDraftEmail.toLowerCase(), /(set up a call|schedule|time windows|times that work)/);
    assert.doesNotMatch(workspace!.event.latestDraftEmail, /\$7,000\s*-\s*\$8,000/i);
    assert.doesNotMatch(workspace!.event.latestDraftEmail, /full Indian wedding package/i);
  });

  it("adds a human-intervention tag when latest context asks high-risk questions the model may not answer confidently", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Taylor Robinson <tjrobinson@createcultivate.com>
Hi there! We're taking over GATHER Espresso Bar + Wine Bar on March 8 from 1 to 3pm and looking for a DJ.
Would love to connect to discuss rates.`,
      uploadedFile: null,
    });

    await ingestInquiry({
      messageText: `Taylor Robinson <tjrobinson@createcultivate.com>
Quick follow-up: can you send a COI and W-9 for procurement before we move forward?`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    assert.match(workspace!.event.latestDraftEmail, /\{HUMAN INTERVENTION NEEDED\}/i);
  });

  it("maps straightforward prose inquiry semantics into workspace fields from raw context", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const year = new Date().getFullYear();
    const created = await ingestInquiry({
      messageText: `Taylor Robinson <tjrobinson@createcultivate.com>
Thu, Mar 5, 8:20 AM (3 days ago)
to me

Hi there!

I hope you’re doing well. We’re taking over GATHER Espresso Bar + Wine Bar this Sunday on March 8 to celebrate International Women’s Day and are looking for a DJ to help set the tone for the evening afternoon portion of the activation from 1 to 3pm.`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    assert.equal(workspace!.client.fullName, "Taylor Robinson");
    assert.equal(workspace!.client.email, "tjrobinson@createcultivate.com");
    assert.equal(workspace!.event.eventType, "Event");
    assert.equal(workspace!.event.eventDate, `${year}-03-08`);
    assert.equal(workspace!.event.venue, "NYC");
    assert.equal(workspace!.event.duration, "1:00pm - 3:00pm");
    assert.equal(workspace!.client.instagramHandle, undefined);
    assert.ok(typeof workspace!.event.workspaceStartTimestamp === "number");
    assert.ok(typeof workspace!.event.workspaceEndTimestamp === "number");
    const start = new Date(workspace!.event.workspaceStartTimestamp!);
    const end = new Date(workspace!.event.workspaceEndTimestamp!);
    assert.equal(start.getHours(), 13);
    assert.equal(end.getHours(), 15);
  });

  it("responds to latest set-sample request and meeting request while still asking missing quote-critical details", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Hi Anupya,

I messaged you on Instagram requesting a DJ for an Indian wedding in February 2027. Below is a general list of genres we’re looking for, if you can send over a set that aligns.

Hindi (Bollywood - old and new and also old school Hindi music)
Telugu - old and more current songs
Tamil songs - 1980s, 1990s, 2000s mostly
Afrobeats
Afro-desi
Reggaeton
English pop and hip hop - old and current

And we can also set up some time to meet at a mutually convenient time.

Thanks so much!
Lavanya`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    const draft = (workspace!.event.latestDraftEmail || "").toLowerCase();
    assert.match(draft, /(send over a sample set|sample set that aligns|set that aligns)/);
    assert.match(draft, /(set up a call|time windows|meet|mutually convenient time)/);
    assert.match(draft, /(event date|wedding date|which date|what date|when is)/);
  });

  it("maps friday/saturday timeline context into event rows and confirms travel inclusion in draft response", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const year = new Date().getFullYear();
    const created = await ingestInquiry({
      messageText: `Shohini Gupta <gupta.shohini@gmail.com>
Hi Anupya,
I'm getting married Sept 25-26 in DC and am starting to look for a DJ for my events.`,
      uploadedFile: null,
    });

    await ingestInquiry({
      messageText: `Shohini Gupta <gupta.shohini@gmail.com>
Mon, Jan 12, 2:43 PM
to me

Hey Anupya - great to chat today.

Hours:
Friday
Welcome Party on Friday - 3-7PM, programming + 1 hr dance floor in the back half but I expect we'll want some music playing through the rest of it too?
Saturday
Ceremony - 3-5pm
Cocktail hour - 5-7 pm
Reception - 7-11pm
And we talked about including the cost of travel to make it easier logistically!`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace?.contract);
    assert.equal(workspace!.event.eventDate, `${year}-09-25`);
    assert.equal(timestampToIsoDate(workspace!.event.workspaceStartTimestamp), `${year}-09-25`);
    assert.equal(timestampToIsoDate(workspace!.event.workspaceEndTimestamp), `${year}-09-26`);
    assert.equal(workspace!.event.venue, "DC");

    const rows = workspace!.contract!.dynamicFields.eventDetails;
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((row) => row.title), ["Welcome Party", "Ceremony", "Cocktail hour", "Reception"]);
    assert.deepEqual(rows.map((row) => row.date), [`${year}-09-25`, `${year}-09-26`, `${year}-09-26`, `${year}-09-26`]);
    assert.deepEqual(rows.map((row) => row.time), ["3:00pm - 7:00pm", "3:00pm - 5:00pm", "5:00pm - 7:00pm", "7:00pm - 11:00pm"]);
    assert.equal(workspace!.contract!.dynamicFields.dueDate, `${year}-09-26`);
    assert.equal(workspace!.contract!.dynamicFields.cancellationDate, `${year}-03-26`);
    assert.match(workspace!.event.latestDraftEmail.toLowerCase(), /(include travel costs|event total|total for dj services)/);
    assert.match(workspace!.event.latestDraftEmail.toLowerCase(), /(reflect them in the contract|jump on a call|questions or concerns)/);
    assert.doesNotMatch(workspace!.event.latestDraftEmail.toLowerCase(), /dhol|emcee|mc\b/);
    const loweredDraft = workspace!.event.latestDraftEmail.toLowerCase();
    assert.ok(
      !(loweredDraft.includes("detailed quote based on what you shared") && loweredDraft.includes("detailed dj quote breakdown"))
    );
  });

  it("detects multiple dated event rows from inquiry lines and preserves overnight reception timing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const year = new Date().getFullYear();
    const created = await ingestInquiry({
      messageText: `Nitya Aziz <aziznitya25@gmail.com>
Mon, Feb 16, 11:49 AM
to me

Hi Anupya,

I’m getting married this July and would love to check your availability for our events at the InterContinental Boston.

July 3rd (7:00 pm – 10:00 pm) – Cocktail Night
July 4th (9:30 am – 1:30 pm) – Baraat & Wedding Ceremony
July 4th (7:00 pm – 1:30 am) – Reception`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace?.contract);
    assert.equal(workspace!.event.eventDate, `${year}-07-03`);
    assert.ok((workspace!.event.venue || "").toLowerCase().includes("boston"));
    assert.equal(timestampToIsoDate(workspace!.event.workspaceStartTimestamp), `${year}-07-03`);
    assert.equal(timestampToIsoDate(workspace!.event.workspaceEndTimestamp), `${year}-07-05`);

    const rows = workspace!.contract!.dynamicFields.eventDetails;
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((row) => row.title), ["Cocktail Night", "Baraat & Wedding Ceremony", "Reception"]);
    assert.deepEqual(rows.map((row) => row.date), [`${year}-07-03`, `${year}-07-04`, `${year}-07-04`]);
    assert.deepEqual(rows.map((row) => row.time), ["7:00pm - 10:00pm", "9:30am - 1:30pm", "7:00pm - 1:30am"]);
  });

  it("maps weekday timeline rows into the correct contract event dates across an Oct 29-31 range", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const year = new Date().getFullYear();
    const created = await ingestInquiry({
      messageText: `Sivani and Vara <sivani@example.com>
Event type: Wedding
Date: Oct 29-31
Location: Dallas
Thursday Night Welcome Dinner 8:30 PM - 12 PM (First hour ish just for cocktails, mingling)
Friday Morning Haldi 11:30 AM - 2 PM (First hour ish just for brunch)
Saturday Morning Ceremony 9 AM - 12 PM (Baaraat, Groom entrance, bridal entrance, talambralu playlist)
Saturday Reception 8 PM - 2 AM (Dance performances, open dance floor)`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace?.contract);

    const rows = workspace!.contract!.dynamicFields.eventDetails;
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((row) => row.date), [`${year}-10-29`, `${year}-10-30`, `${year}-10-31`, `${year}-10-31`]);
    assert.equal(workspace!.event.eventDate, `${year}-10-29`);
    assert.equal(timestampToIsoDate(workspace!.event.workspaceStartTimestamp), `${year}-10-29`);
    assert.equal(timestampToIsoDate(workspace!.event.workspaceEndTimestamp), `${year}-11-01`);
  });

  it("infers named events and per-event notes from new context using prior date range context", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const year = new Date().getFullYear();
    const created = await ingestInquiry({
      messageText: `Harshala <bhwedding90@gmail.com>
Date: December 21/22 ${year}
Location: Cancun, Mexico
Need DJ services for a wedding.`,
      uploadedFile: null,
    });

    await ingestInquiry({
      messageText: `Harshala <bhwedding90@gmail.com>
It’s a Hindu - Catholic wedding. On 21st we have the Sangeet and 22nd is the reception.
Both the events are from 7pm to 11pm.
It’s in Cancun, Mexico.
For the Sangeet- we would have some family and friends performing followed by dancing so looking at Bollywood/ hip hop music.
For the reception- hip hop/ rap`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace?.contract);
    const rows = workspace!.contract!.dynamicFields.eventDetails;
    const byTitle = new Map(rows.map((row) => [row.title.toLowerCase(), row]));

    assert.equal(byTitle.get("sangeet")?.date, `${year}-12-21`);
    assert.equal(byTitle.get("reception")?.date, `${year}-12-22`);
    assert.match(((byTitle.get("sangeet")?.time || "").replace(/\s+/g, "").toLowerCase()), /^7:00pm-11:00pm$/);
    assert.match(((byTitle.get("reception")?.time || "").replace(/\s+/g, "").toLowerCase()), /^7:00pm-11:00pm$/);
    assert.match((byTitle.get("sangeet")?.notes || "").toLowerCase(), /bollywood.*hip hop/);
    assert.match((byTitle.get("reception")?.notes || "").toLowerCase(), /hip hop\/ rap/);
    assert.equal(workspace!.event.venue, "Cancun, Mexico");
  });

  it("preserves manually approved pricing when timing is unchanged, and recalculates when timing changes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Anjali Trivedi <anjali@example.com>
Event type: Wedding
Date: May 23rd, 2027
Location: The Rockleigh, New Jersey
Time: 7:30 pm - 10:30 pm
Services needed: DJ
Best,
Anjali Trivedi`,
      uploadedFile: null,
    });

    const initial = await getWorkspaceByEventId(created.eventId);
    assert.ok(initial?.contract);
    const manualFields = structuredClone(initial!.contract!.dynamicFields);
    manualFields.eventDetails[0].amount = 2000;

    await updateWorkspace({
      eventId: created.eventId,
      contractFields: manualFields,
      approveContractFields: true,
    });

    await ingestInquiry({
      messageText: `anjali parth
Following up on timeline details.
Time: 7:30 pm - 10:30 pm
Thanks,
Anjali Trivedi`,
      uploadedFile: null,
    });

    const afterSameTime = await getWorkspaceByEventId(created.eventId);
    assert.ok(afterSameTime?.contract);
    assert.equal(afterSameTime!.contract!.dynamicFields.eventDetails[0].time, "7:30 pm - 10:30 pm");
    assert.equal(afterSameTime!.contract!.dynamicFields.eventDetails[0].amount, 2000);

    await ingestInquiry({
      messageText: `anjali parth
Small update:
Time: 7:30 pm - 11:30 pm
Thanks,
Anjali Trivedi`,
      uploadedFile: null,
    });

    const afterChangedTime = await getWorkspaceByEventId(created.eventId);
    assert.ok(afterChangedTime?.contract);
    assert.equal(afterChangedTime!.contract!.dynamicFields.eventDetails[0].time, "7:30 pm - 11:30 pm");
    assert.equal(afterChangedTime!.contract!.dynamicFields.eventDetails[0].amount, 3000);
  });

  it("recalculates per-event amount from manual contract time changes at $600/hour", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Anjali Trivedi <anjali@example.com>
Event type: Wedding
Date: May 23rd, 2027
Location: The Rockleigh, New Jersey
Time: 5:00 pm - 7:00 pm
Services needed: DJ`,
      uploadedFile: null,
    });

    const initial = await getWorkspaceByEventId(created.eventId);
    assert.ok(initial?.contract);
    assert.equal(initial!.contract!.dynamicFields.eventDetails[0].amount, 1800);

    const editedFields = structuredClone(initial!.contract!.dynamicFields);
    editedFields.eventDetails[0].time = "5:00 pm - 9:00 pm";
    editedFields.eventDetails[0].amount = 1200;

    const updated = await updateWorkspace({
      eventId: created.eventId,
      contractFields: editedFields,
      approveContractFields: true,
    });

    assert.ok(updated?.contract);
    assert.equal(updated!.contract!.dynamicFields.eventDetails[0].time, "5:00 pm - 9:00 pm");
    assert.equal(updated!.contract!.dynamicFields.eventDetails[0].amount, 3000);

    const overnightFields = structuredClone(updated!.contract!.dynamicFields);
    overnightFields.eventDetails[0].time = "19:00-00:00";
    overnightFields.eventDetails[0].amount = 0;

    const overnightUpdated = await updateWorkspace({
      eventId: created.eventId,
      contractFields: overnightFields,
      approveContractFields: true,
    });

    assert.ok(overnightUpdated?.contract);
    assert.equal(overnightUpdated!.contract!.dynamicFields.eventDetails[0].time, "19:00-00:00");
    assert.equal(overnightUpdated!.contract!.dynamicFields.eventDetails[0].amount, 3600);
  });

  it("preserves event label like engagement party and prices 7pm-12am as $3600 after follow-up", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const first = await ingestInquiry({
      messageText: `Sai Vasu <saiandvasu2027@gmail.com>
Hi Anupya!
My fiancée and I are looking for a DJ for our engagement party on July 4th, 2026 and really like your stuff! Please let me know if you are available!`,
      uploadedFile: null,
    });

    await updateWorkspace({
      eventId: first.eventId,
      approveDraftEmail: true,
    });

    const afterApprove = await getWorkspaceByEventId(first.eventId);
    assert.ok(afterApprove);

    const updatedRaw = `${afterApprove!.event.latestOcrText}

----- New Context -----

Sai Vasu
Hey!
Thanks for getting back to me.
We are still touring venues but the guest count is 150 and times are 7pm-12am!`;

    await updateWorkspace({
      eventId: first.eventId,
      ocrText: updatedRaw,
      reanalyzeFromRaw: true,
    });

    const workspace = await getWorkspaceByEventId(first.eventId);
    assert.ok(workspace?.contract);
    const row = workspace!.contract!.dynamicFields.eventDetails[0];
    assert.equal(row.title, "Engagement Party");
    assert.equal(row.amount, 3600);
    assert.equal(row.date, "2026-07-04");
  });

  it("applies approved draft pricing directives to contract totals", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Anjali Trivedi <anjali@example.com>
Event type: Wedding
Date: May 23rd, 2027
Location: The Rockleigh, New Jersey
Time: 7:30 pm - 10:30 pm
Services needed: DJ`,
      uploadedFile: null,
    });

    const updated = await updateWorkspace({
      eventId: created.eventId,
      emailDraft: `Hey Anjali,\n\nThanks for the details. I can offer a $500 discount, so your updated quote total is $1,300.\n\nBest,\nAnupya`,
      approveDraftEmail: true,
    });

    assert.ok(updated?.contract);
    assert.equal(updated!.contract!.dynamicFields.totalAmount, 1300);
    assert.equal(updated!.contract!.dynamicFields.depositAmount, 325);
    assert.equal(updated!.contract!.dynamicFields.remainingAmount, 975);
  });

  it("applies explicit per-event pricing breakdown from approved draft email to contract event rows", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Sivani and Vara <sv@example.com>
Event type: Wedding
Date: October 29-31, 2027
Location: NYC
Timeline:
Welcome Dinner 6:00 pm - 10:00 pm
Haldi 10:00 am - 1:00 pm
Baraat 1:00 pm - 2:00 pm
Ceremony 2:00 pm - 5:00 pm
Reception 7:00 pm - 12:00 am
Services needed: DJ`,
      uploadedFile: null,
    });

    const updated = await updateWorkspace({
      eventId: created.eventId,
      emailDraft: `Hey Sivani and Vara!

Thanks for sending this over! I am available like i said for Oct 29-31. I did a quick calculation and I can bring the total for these events to $9.4K. Breakdown is as follows:

Welcome Dinner $2,400
Haldi $1,800
Baraat $1,000 ($600 if not mobile)
Ceremony $0 (Free if i do all the events, otherwise $1,800)
Reception $4,200

Let me know if that makes sense, happy to jump on a call to discuss further!

Best,
Anupya`,
      approveDraftEmail: true,
    });

    assert.ok(updated?.contract);
    const rows = updated!.contract!.dynamicFields.eventDetails;
    const amountByTitle = new Map(rows.map((row) => [row.title.toLowerCase(), row.amount]));
    assert.equal(amountByTitle.get("welcome dinner"), 2400);
    assert.equal(amountByTitle.get("haldi"), 1800);
    assert.equal(amountByTitle.get("baraat"), 1000);
    assert.equal(amountByTitle.get("ceremony"), 0);
    assert.equal(amountByTitle.get("reception"), 4200);
    assert.equal(updated!.contract!.dynamicFields.totalAmount, 9400);
    assert.equal(updated!.contract!.dynamicFields.depositAmount, 2350);
    assert.equal(updated!.contract!.dynamicFields.remainingAmount, 7050);
  });

  it("keeps auto pricing at +1 hour and stores manual override from priced lines containing time ranges", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Harshala <bhwedding90@gmail.com>
Event type: Wedding
Date: December 21/22 2027
Location: Cancun, Mexico
Timeline:
Sangeet 6:30 - 11:30
Reception 6:30 - 11:30
Services needed: DJ`,
      uploadedFile: null,
    });

    const before = await getWorkspaceByEventId(created.eventId);
    assert.ok(before?.contract);
    const seeded = structuredClone(before!.contract!.dynamicFields);
    seeded.eventDetails = [
      {
        id: seeded.eventDetails[0]?.id || "detail_seed_1",
        title: "Sangeet",
        date: "2027-12-21",
        time: "6:30 - 11:30",
        location: "Cancun, Mexico",
        notes: "",
        amount: 3600,
      },
      {
        id: "detail_seed_2",
        title: "Reception",
        date: "2027-12-22",
        time: "6:30 - 11:30",
        location: "Cancun, Mexico",
        notes: "",
        amount: 3600,
      },
    ];
    await updateWorkspace({
      eventId: created.eventId,
      contractFields: seeded,
      approveContractFields: true,
    });

    const updated = await updateWorkspace({
      eventId: created.eventId,
      emailDraft: `Hi Harshala!

Great thanks for the info! I'll give you the standard rates below for a destination wedding.
Sangeet (6:30 - 11:30) - $3000
Reception (6:30 - 11:30) - $3000

Best,
Anupya`,
      approveDraftEmail: true,
    });

    assert.ok(updated?.contract);
    const rows = updated!.contract!.dynamicFields.eventDetails;
    const amountByTitle = new Map(rows.map((row) => [row.title.toLowerCase(), row.amount]));
    const overrideByTitle = new Map(rows.map((row) => [row.title.toLowerCase(), row.manualOverridePrice]));
    assert.equal(amountByTitle.get("sangeet"), 3600);
    assert.equal(amountByTitle.get("reception"), 3600);
    assert.equal(overrideByTitle.get("sangeet"), 3000);
    assert.equal(overrideByTitle.get("reception"), 3000);
  });

  it("stores per-event manual override prices when approved draft pricing differs from predicted event amounts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Anjali Trivedi <anjali@example.com>
Event type: Wedding
Date: May 23rd, 2027
Location: The Rockleigh, New Jersey
Timeline:
9:00-10:00am Barat
10:00-12:00pm Wedding Ceremony
6:00-7:30pm Cocktail Hour
7:30-11:30pm Reception
Services needed: DJ`,
      uploadedFile: null,
    });

    const before = await getWorkspaceByEventId(created.eventId);
    assert.ok(before?.contract);
    const beforeAmountByTitle = new Map(before!.contract!.dynamicFields.eventDetails.map((row) => [row.title.toLowerCase(), row.amount]));
    assert.equal(beforeAmountByTitle.get("barat"), 1200);
    assert.equal(beforeAmountByTitle.get("wedding ceremony"), 1800);
    assert.equal(beforeAmountByTitle.get("cocktail hour"), 1500);
    assert.equal(beforeAmountByTitle.get("reception"), 3000);

    const updated = await updateWorkspace({
      eventId: created.eventId,
      emailDraft: `Hey Anjali,

Thanks for sharing the timeline. Here is the updated pricing breakdown:

Barat $1,000
Wedding Ceremony $1,200
Cocktail Hour $900
Reception $3,000

Best,
Anupya`,
      approveDraftEmail: true,
    });

    assert.ok(updated?.contract);
    const rows = updated!.contract!.dynamicFields.eventDetails;
    const amountByTitle = new Map(rows.map((row) => [row.title.toLowerCase(), row.amount]));
    const overrideByTitle = new Map(rows.map((row) => [row.title.toLowerCase(), row.manualOverridePrice]));

    assert.equal(amountByTitle.get("barat"), 1200);
    assert.equal(amountByTitle.get("wedding ceremony"), 1800);
    assert.equal(amountByTitle.get("cocktail hour"), 1500);
    assert.equal(amountByTitle.get("reception"), 3000);
    assert.equal(overrideByTitle.get("barat"), 1000);
    assert.equal(overrideByTitle.get("wedding ceremony"), 1200);
    assert.equal(overrideByTitle.get("cocktail hour"), 900);
    assert.equal(overrideByTitle.get("reception"), undefined);
    assert.equal(updated!.contract!.dynamicFields.totalAmount, 6100);
    assert.equal(updated!.contract!.dynamicFields.depositAmount, 1525);
    assert.equal(updated!.contract!.dynamicFields.remainingAmount, 4575);
  });

  it("updates profile and event date range from follow-up context corrections in the same workspace", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `H Trivedi <harshala@example.com>
Event type: Wedding
Date: December 21, 2026
Services needed: DJ`,
      uploadedFile: null,
    });

    await ingestInquiry({
      messageText: `Harshala Trivedi <harshala@example.com>
Location: The Rockleigh, New Jersey
Date: December 21/22 2026
Best,
Harshala Trivedi`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    assert.equal(workspace!.client.fullName, "Harshala Trivedi");
    assert.equal(workspace!.client.email, "harshala@example.com");
    assert.equal(workspace!.event.venue, "The Rockleigh, New Jersey");
    assert.equal(workspace!.event.eventDate, "2026-12-21");
    assert.equal(timestampToIsoDate(workspace!.event.workspaceStartTimestamp), "2026-12-21");
    assert.equal(timestampToIsoDate(workspace!.event.workspaceEndTimestamp), "2026-12-22");
  });

  it("reapplies latest approved draft pricing after new context updates and updates again on next approved draft", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Ethan and Gaby <ethan@example.com>
Event type: Event
Date: May 1st, 2027
Location: NYC
Time: 7:30 pm - 10:30 pm
Services needed: DJ`,
      uploadedFile: null,
    });

    await updateWorkspace({
      eventId: created.eventId,
      emailDraft: `Hey Ethan and Gaby,\n\nI can do this for $2,200 total.\n\nBest,\nAnupya`,
      approveDraftEmail: true,
    });

    await ingestInquiry({
      messageText: `Ethan and Gaby <ethan@example.com>
Quick update:
Time: 7:30 pm - 11:30 pm
Thanks!`,
      uploadedFile: null,
    });

    const afterContextUpdate = await getWorkspaceByEventId(created.eventId);
    assert.ok(afterContextUpdate?.contract);
    assert.equal(afterContextUpdate!.contract!.dynamicFields.totalAmount, 2200);

    const afterSecondApproval = await updateWorkspace({
      eventId: created.eventId,
      emailDraft: `Hey Ethan and Gaby,\n\nUpdated quote total is $2,700.\n\nBest,\nAnupya`,
      approveDraftEmail: true,
    });

    assert.ok(afterSecondApproval?.contract);
    assert.equal(afterSecondApproval!.contract!.dynamicFields.totalAmount, 2700);
  });

  it("recomputes cancellation deadline when final payment due date is manually changed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Anjali Trivedi <anjali@example.com>
Event type: Wedding
Date: May 23rd, 2027
Location: The Rockleigh, New Jersey
Time: 7:30 pm - 10:30 pm
Services needed: DJ`,
      uploadedFile: null,
    });

    const initial = await getWorkspaceByEventId(created.eventId);
    assert.ok(initial?.contract);
    const editedFields = structuredClone(initial!.contract!.dynamicFields);
    editedFields.dueDate = "2027-06-15";

    const updated = await updateWorkspace({
      eventId: created.eventId,
      contractFields: editedFields,
      approveContractFields: true,
    });

    assert.ok(updated?.contract);
    assert.equal(updated!.contract!.dynamicFields.dueDate, "2027-06-15");
    assert.equal(updated!.contract!.dynamicFields.cancellationDate, "2026-12-15");
  });

  it("uses latest submitted context for draft email but full raw context for contract fields", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Anjali Trivedi <anjali@example.com>
Event type: Wedding
Date: May 23rd, 2027
Location: The Rockleigh, New Jersey
Services needed: DJ, MC
Best,
Anjali Trivedi`,
      uploadedFile: null,
    });

    await ingestInquiry({
      messageText: `anjali parth
Timeline update:
9:00-10:00am Barat
10:00-12:00pm Wedding Ceremony
6:00-7:30pm Cocktail Hour
7:30-11:30pm Reception

Thanks,
Anjali Trivedi`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace?.contract);
    assert.equal(workspace!.contract!.dynamicFields.eventDetails[0].location, "The Rockleigh, New Jersey");
    assert.doesNotMatch(workspace!.event.latestDraftEmail, /venue\/location/i);
    assert.doesNotMatch(workspace!.event.latestDraftEmail.toLowerCase(), /best email|contract|draft/);
    assert.match(workspace!.event.latestDraftEmail.toLowerCase(), /quote/);
  });

  it("ensures each contract event row has a unique id for independent editing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Taylor Kim <taylor@example.com>
Event type: Wedding
Date: September 10, 2027
Location: NYC
Services needed: DJ`,
      uploadedFile: null,
    });

    await ingestInquiry({
      messageText: `Taylor Kim <taylor@example.com>
Timeline:
7:00-8:00pm Wedding
8:00-9:00pm Wedding
9:00-10:00pm Wedding`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace?.contract);
    const ids = workspace!.contract!.dynamicFields.eventDetails.map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("reanalysis from edited raw context drops stale inferred event rows that were removed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Anjali Trivedi <anjali@example.com>
Date: May 23, 2027
Location: NYC
Barat - 9:00am - 10:00am
Reception - 7:00pm - 11:00pm`,
      uploadedFile: null,
    });

    let workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace?.contract);
    assert.equal(workspace!.contract!.dynamicFields.eventDetails.length, 2);

    workspace = await updateWorkspace({
      eventId: created.eventId,
      ocrText: `Anjali Trivedi <anjali@example.com>
Date: May 23, 2027
Location: NYC
Reception - 7:00pm - 11:00pm`,
      reanalyzeFromRaw: true,
    });

    assert.ok(workspace?.contract);
    const rows = workspace!.contract!.dynamicFields.eventDetails;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, "Reception");
  });

  it("uses multi-day wedding range from body text for workspace start/end when event timings are missing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const year = new Date().getFullYear();
    const created = await ingestInquiry({
      messageText: `Shohini Gupta <gupta.shohini@gmail.com>
Wed, Jan 7, 7:12 PM
to me

Hi Anupya,
I'm getting married Sept 25-26 in DC and am starting to look for a DJ for my events.
Would love to know if you're available and what your price range looks like.`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    assert.equal(workspace!.event.eventDate, `${year}-09-25`);
    assert.equal(timestampToIsoDate(workspace!.event.workspaceStartTimestamp), `${year}-09-25`);
    assert.equal(timestampToIsoDate(workspace!.event.workspaceEndTimestamp), `${year}-09-26`);
    assert.equal(workspace!.event.venue, "DC");
    assert.match(workspace!.event.latestDraftEmail.toLowerCase(), /(start and end times|timeline|time)/);
  });

  it("asks for event date clarification and never states availability when date is missing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Lavanya and Pranav <pranavandlavanya@lavanav.com>
Feb 26, 2026, 2:30 PM (9 days ago)
to me

Hi Anupya,
We're planning our wedding and exploring DJs.
Could you share pricing and process?`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    const draft = workspace!.event.latestDraftEmail.toLowerCase();
    assert.match(draft, /(event date|wedding date|which date|what date|when is)/);
    assert.match(draft, /(start and end times|timeline|event segment)/);
    assert.doesNotMatch(draft, /unknown is tentatively|tentatively open|tentatively available/);
    const timelinePhraseCount = (draft.match(/complete timeline for each event segment/g) || []).length;
    assert.ok(timelinePhraseCount <= 1);
  });

  it("does not mention unconfirmed inquiry conflicts when same-date workspace is still inquiry stage", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    await ingestInquiry({
      messageText: `Aarav Mehta <aarav@example.com>
Event type: Wedding
Date: July 4, 2027
Location: NYC
Services needed: DJ`,
      uploadedFile: null,
    });

    const second = await ingestInquiry({
      messageText: `Lina Torres <lina@example.com>
Event type: Wedding
Date: July 5, 2027
Location: Los Angeles
Services needed: DJ`,
      uploadedFile: null,
    });

    const revised = await updateWorkspace({
      eventId: second.eventId,
      ocrText: `Lina Torres <lina@example.com>
Event type: Wedding
Date: July 4, 2027
Location: NYC
Services needed: DJ`,
      reanalyzeFromRaw: true,
    });

    const workspace = revised || (await getWorkspaceByEventId(second.eventId));
    assert.ok(workspace);
    assert.doesNotMatch(workspace!.event.latestDraftEmail.toLowerCase(), /another inquiry|not confirmed/);
    assert.match(workspace!.event.latestDraftEmail.toLowerCase(), /tentatively open|tentatively available/);
  });

  it("uses unavailable language when same-date workspace is already in contract", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const first = await ingestInquiry({
      messageText: `Aarav Mehta <aarav@example.com>
Event type: Wedding
Date: July 4, 2027
Location: NYC
Time: 5:00 pm - 9:00 pm
Services needed: DJ`,
      uploadedFile: null,
    });

    await updateWorkspace({
      eventId: first.eventId,
      signedContract: true,
      initialDepositReceived: true,
    });

    const second = await ingestInquiry({
      messageText: `Lina Torres <lina@example.com>
Event type: Wedding
Date: July 5, 2027
Location: Los Angeles
Services needed: DJ`,
      uploadedFile: null,
    });

    const revised = await updateWorkspace({
      eventId: second.eventId,
      ocrText: `Lina Torres <lina@example.com>
Event type: Wedding
Date: July 4, 2027
Location: NYC
Services needed: DJ`,
      reanalyzeFromRaw: true,
    });

    const workspace = revised || (await getWorkspaceByEventId(second.eventId));
    assert.ok(workspace);
    assert.match(workspace!.event.latestDraftEmail.toLowerCase(), /not available/);
  });

  it("treats same-date cancelled workspace as available", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const first = await ingestInquiry({
      messageText: `Aarav Mehta <aarav@example.com>
Event type: Wedding
Date: July 4, 2027
Location: NYC
Services needed: DJ`,
      uploadedFile: null,
    });

    await updateWorkspace({
      eventId: first.eventId,
      emailDraft: "Hey,\n\nI am unavailable for this date.\n\nBest,\nAnupya",
      approveDraftEmail: true,
    });

    const second = await ingestInquiry({
      messageText: `Lina Torres <lina@example.com>
Event type: Wedding
Date: July 5, 2027
Location: Los Angeles
Services needed: DJ`,
      uploadedFile: null,
    });

    const revised = await updateWorkspace({
      eventId: second.eventId,
      ocrText: `Lina Torres <lina@example.com>
Event type: Wedding
Date: July 4, 2027
Location: NYC
Services needed: DJ`,
      reanalyzeFromRaw: true,
    });

    const workspace = revised || (await getWorkspaceByEventId(second.eventId));
    assert.ok(workspace);
    assert.doesNotMatch(workspace!.event.latestDraftEmail.toLowerCase(), /another inquiry/);
    assert.doesNotMatch(workspace!.event.latestDraftEmail.toLowerCase(), /not available/);
    assert.match(workspace!.event.latestDraftEmail.toLowerCase(), /tentatively open/);
  });

  it("avoids repeating availability statements when already communicated in approved draft and no explicit ask exists", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Lina Torres <lina@example.com>
Event type: Wedding
Date: July 4, 2027
Location: NYC
Services needed: DJ`,
      uploadedFile: null,
    });

    await updateWorkspace({
      eventId: created.eventId,
      emailDraft: `Hey Lina,\n\nJuly 4, 2027 is tentatively open for me right now.\n\nBest,\nAnupya`,
      approveDraftEmail: true,
    });

    await ingestInquiry({
      messageText: `Lina Torres <lina@example.com>
Thanks for confirming. Noted!`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    assert.doesNotMatch(workspace!.event.latestDraftEmail.toLowerCase(), /tentatively open|tentatively available/);
    assert.doesNotMatch(workspace!.event.latestDraftEmail.toLowerCase(), /another inquiry|not confirmed/);
  });

  it("applies availability conflict rules when time windows overlap across different start dates", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const first = await ingestInquiry({
      messageText: `Aarav Mehta <aarav@example.com>
Event type: Wedding
Date: July 3-5, 2027
Location: NYC
Services needed: DJ`,
      uploadedFile: null,
    });

    await updateWorkspace({
      eventId: first.eventId,
      signedContract: true,
      initialDepositReceived: true,
    });

    const second = await ingestInquiry({
      messageText: `Lina Torres <lina@example.com>
Event type: Wedding
Date: July 4, 2027
Location: Los Angeles
Services needed: DJ`,
      uploadedFile: null,
    });

    const revised = await updateWorkspace({
      eventId: second.eventId,
      ocrText: `Lina Torres <lina@example.com>
Event type: Wedding
Date: July 4, 2027
Location: NYC
Services needed: DJ`,
      reanalyzeFromRaw: true,
    });

    const workspace = revised || (await getWorkspaceByEventId(second.eventId));
    assert.ok(workspace);
    assert.match(workspace!.event.latestDraftEmail.toLowerCase(), /not available/);
  });

  it("approving contract auto-saves memory snapshots with raw context and dynamic fields, preserving prior snapshots", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Anjali Trivedi <anjali@example.com>
Event type: Wedding
Date: May 23rd, 2027
Location: The Rockleigh, New Jersey
Time: 7:30 pm - 10:30 pm
Services needed: DJ`,
      uploadedFile: null,
    });

    await updateWorkspace({
      eventId: created.eventId,
      approveContract: true,
    });

    await ingestInquiry({
      messageText: `Anjali Trivedi <anjali@example.com>
Updated details:
Date: May 24th, 2027
Time: 7:30 pm - 11:30 pm
Location: Park Chateau, New Jersey`,
      uploadedFile: null,
    });

    await updateWorkspace({
      eventId: created.eventId,
      approveContract: true,
    });

    const store = await readStore();
    const memoryContracts = store.trainingExamples.filter(
      (example) => example.eventId === created.eventId && example.artifactType === "contract" && example.decision === "approved"
    );

    assert.equal(memoryContracts.length, 2);
    assert.ok(memoryContracts[0].rawContextSnapshot?.includes("The Rockleigh"));
    assert.ok(memoryContracts[1].rawContextSnapshot?.includes("Park Chateau"));
    assert.ok(memoryContracts[0].contractDynamicFieldsSnapshot);
    assert.ok(memoryContracts[1].contractDynamicFieldsSnapshot);
    assert.ok((memoryContracts[0].contractVersionSnapshot || 0) < (memoryContracts[1].contractVersionSnapshot || 0));
  });

  it("marks workspace as cancelled when an approved draft email indicates unavailability", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Maya Patel <maya@example.com>
Event type: Wedding
Date: October 20, 2027
Location: NYC
Time: 5:00 pm - 9:00 pm
Services needed: DJ`,
      uploadedFile: null,
    });

    const updated = await updateWorkspace({
      eventId: created.eventId,
      emailDraft: `Hey Maya,\n\nI am unavailable for this date.\n\nBest,\nAnupya`,
      approveDraftEmail: true,
    });

    assert.ok(updated);
    assert.equal(updated!.event.status, "cancelled");
    assert.equal(updated!.event.stage, "cancelled");
  });

  it("adds adjustment checklist actions when an approved in-contract revision changes totals/deposit", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Maya Patel <maya@example.com>
Event type: Wedding
Date: October 20, 2027
Location: NYC
Time: 5:00 pm - 9:00 pm
Services needed: DJ`,
      uploadedFile: null,
    });

    await updateWorkspace({
      eventId: created.eventId,
      signedContract: true,
      initialDepositReceived: true,
    });

    const firstApproved = await updateWorkspace({
      eventId: created.eventId,
      approveContract: true,
    });
    assert.ok(firstApproved?.contract);

    const revisedFields = structuredClone(firstApproved!.contract!.dynamicFields);
    revisedFields.eventDetails[0].amount += 400;

    const revisedApproved = await updateWorkspace({
      eventId: created.eventId,
      contractFields: revisedFields,
      approveContract: true,
    });

    assert.ok(revisedApproved);
    assert.equal(revisedApproved!.event.needsAdjustedContractSignature, true);
    assert.equal(revisedApproved!.event.adjustedContractSigned, false);
    assert.equal(revisedApproved!.event.needsAdditionalDepositCollection, true);
    assert.equal(revisedApproved!.event.additionalDepositCollected, false);
    assert.equal(revisedApproved!.event.additionalDepositAmountDue, 100);

    const checklistCompleted = await updateWorkspace({
      eventId: created.eventId,
      adjustedContractSigned: true,
      additionalDepositCollected: true,
    });
    assert.ok(checklistCompleted);
    assert.equal(checklistCompleted!.event.needsAdjustedContractSignature, false);
    assert.equal(checklistCompleted!.event.needsAdditionalDepositCollection, false);
    assert.equal(checklistCompleted!.event.additionalDepositAmountDue, undefined);
  });

  it("marks workspace as completed when workspace end timestamp has passed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const currentYear = new Date().getFullYear();
    const pastYear = currentYear - 1;

    const created = await ingestInquiry({
      messageText: `Past Client <past@example.com>
Event type: Reception
Date: May 1st, ${pastYear}
Location: NYC
Time: 7:30 pm - 10:30 pm
Services needed: DJ`,
      uploadedFile: null,
    });

    await updateWorkspace({
      eventId: created.eventId,
      signedContract: true,
      initialDepositReceived: true,
      fullInvoicePaid: true,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    assert.equal(workspace!.event.status, "completed");
    assert.ok(workspace!.event.workspaceStartTimestamp);
    assert.ok(workspace!.event.workspaceEndTimestamp);
  });

  it("marks workspace as cancelled when latest client context indicates they chose another vendor", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Riya Patel <riya@example.com>
Event type: Wedding
Date: October 20, 2027
Location: NYC
Time: 5:00 pm - 9:00 pm
Services needed: DJ`,
      uploadedFile: null,
    });

    await ingestInquiry({
      messageText: `Riya Patel <riya@example.com>
Thanks again for your time. We decided to go with another DJ and won't be moving forward.`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    assert.equal(workspace!.event.status, "cancelled");
    assert.equal(workspace!.event.stage, "cancelled");
    assert.equal(workspace!.event.latestDraftEmail, "Good effort, add context if they change their minds!");
  });

  it("marks workspace as cancelled for 'go with someone here' context and drafts a supportive closeout", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Nitya Devireddy <nitya@example.com>
Event type: Wedding
Date: July 3, 2026
Location: Boston
Services needed: DJ`,
      uploadedFile: null,
    });

    await ingestInquiry({
      messageText: `Nitya Devireddy <nitya@example.com>
We’ve decided to go with someone here to make the logistics easier and bring the cost down.
Thank you so very much for checking in on the AV portion of things and for trying to make it all come together, we really appreciate it 😊`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    assert.equal(workspace!.event.status, "cancelled");
    assert.equal(workspace!.event.latestDraftEmail, "Good effort, add context if they change their minds!");
  });

  it("uploads checklist proofs and validates deposit/invoice amounts via OCR text extraction", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Maya Patel <maya@example.com>
Event type: Wedding
Date: October 20, 2027
Location: NYC
Time: 5:00 pm - 9:00 pm
Services needed: DJ`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace?.contract);
    assert.ok(workspace?.invoice);

    const expectedDeposit = workspace!.contract!.dynamicFields.depositAmount;
    const expectedInvoice = workspace!.invoice!.balanceRemaining;

    const signed = await uploadWorkspaceChecklistProof({
      eventId: created.eventId,
      kind: "signed_contract",
      file: new File(["Signed contract copy"], "signed_contract.txt", { type: "text/plain" }),
    });
    assert.ok(signed);
    assert.equal(signed!.amountMatched, true);
    assert.equal(signed!.ocrStatus, "not_needed");

    const deposit = await uploadWorkspaceChecklistProof({
      eventId: created.eventId,
      kind: "deposit_proof",
      file: new File([`Deposit paid: $${expectedDeposit}`], "deposit_proof.txt", { type: "text/plain" }),
    });
    assert.ok(deposit);
    assert.equal(deposit!.amountMatched, true);
    assert.equal(deposit!.expectedAmount, expectedDeposit);
    assert.equal(deposit!.extractedAmount, expectedDeposit);

    const invoice = await uploadWorkspaceChecklistProof({
      eventId: created.eventId,
      kind: "invoice_proof",
      file: new File([`Final payment received USD ${expectedInvoice}`], "invoice_proof.txt", { type: "text/plain" }),
    });
    assert.ok(invoice);
    assert.equal(invoice!.amountMatched, true);
    assert.equal(invoice!.expectedAmount, expectedInvoice);
    assert.equal(invoice!.extractedAmount, expectedInvoice);

    const refreshed = await getWorkspaceByEventId(created.eventId);
    assert.ok(refreshed);
    assert.equal(refreshed!.documents.length, 3);
  });

  it("flags amount mismatch when OCR-extracted deposit does not match expected contract deposit", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Nina Rao <nina@example.com>
Event type: Wedding
Date: October 20, 2027
Location: NYC
Time: 5:00 pm - 9:00 pm
Services needed: DJ`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace?.contract);
    const expectedDeposit = workspace!.contract!.dynamicFields.depositAmount;

    const proof = await uploadWorkspaceChecklistProof({
      eventId: created.eventId,
      kind: "deposit_proof",
      file: new File([`Amount paid: $${expectedDeposit + 100}`], "deposit_mismatch.txt", { type: "text/plain" }),
    });
    assert.ok(proof);
    assert.equal(proof!.amountMatched, false);
    assert.equal(proof!.expectedAmount, expectedDeposit);
  });

  it("never stores owner identity as workspace primary contact", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Nitya Devireddy <nitya@example.com>
Event type: Wedding
Date: July 3, 2026
Location: Boston
Services needed: DJ`,
      uploadedFile: null,
    });

    await updateWorkspace({
      eventId: created.eventId,
      profile: {
        primaryClientName: "Anupya Nalamalapu",
        primaryEmail: "djanupya@gmail.com",
        primaryPhone: "+1 408 887 2397",
        primaryInstagramHandle: "@djanupya",
        secondaryClientName: "",
        secondaryEmail: "",
        secondaryPhone: "",
        secondaryInstagramHandle: "",
        weddingPlannerName: "",
        weddingPlannerEmail: "",
        weddingPlannerPhone: "",
        weddingPlannerInstagramHandle: "",
        avVendorName: "",
        avVendorEmail: "",
        avVendorPhone: "",
        avVendorInstagramHandle: "",
        customFields: [],
      },
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    assert.notEqual(workspace!.client.fullName.toLowerCase(), "anupya nalamalapu");
    assert.notEqual(workspace!.client.email.toLowerCase(), "djanupya@gmail.com");
    assert.notEqual((workspace!.client.phone || "").replace(/\D+/g, ""), "4088872397");
    assert.notEqual((workspace!.client.phone || "").replace(/\D+/g, ""), "14088872397");
    assert.notEqual((workspace!.client.instagramHandle || "").toLowerCase(), "@djanupya");
    assert.notEqual((workspace!.event.profile?.primaryClientName || "").toLowerCase(), "anupya nalamalapu");
    assert.notEqual((workspace!.event.profile?.primaryEmail || "").toLowerCase(), "djanupya@gmail.com");
    assert.notEqual((workspace!.event.profile?.primaryPhone || "").replace(/\D+/g, ""), "4088872397");
    assert.notEqual((workspace!.event.profile?.primaryPhone || "").replace(/\D+/g, ""), "14088872397");
    assert.notEqual((workspace!.event.profile?.primaryInstagramHandle || "").toLowerCase(), "@djanupya");
  });
});
