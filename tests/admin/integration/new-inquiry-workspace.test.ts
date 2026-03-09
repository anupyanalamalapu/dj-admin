import assert from "node:assert/strict";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, it } from "node:test";
import { ingestInquiry, getWorkspaceByEventId, updateWorkspace } from "../../../lib/admin/orchestration/admin-service";
import { timestampToIsoDate } from "../../../lib/admin/utils/date";

describe("new inquiry integration", () => {
  it("creates client/event and returns workspace", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const result = await ingestInquiry({
      messageText: `sarah inquiry <sarah@example.com>
Hi Anupya, inquiry for a wedding on 2026-09-26 at Vanderbilt Museum. Need DJ and MC.

Best,
Sarah Lee`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(result.eventId);

    assert.ok(workspace);
    assert.equal(workspace?.client.fullName, "Sarah Lee");
    assert.equal(workspace?.client.email, "sarah@example.com");
    assert.equal(workspace?.event.stage, "inquiry");
    assert.ok(workspace?.event.profile);
    assert.equal(workspace?.event.profile?.primaryClientName, "Sarah Lee");
    assert.equal(workspace?.event.profile?.secondaryClientName, "");
    assert.equal(workspace?.event.profile?.weddingPlannerName, "");
    assert.equal(workspace?.event.profile?.avVendorName, "");
    assert.ok(workspace?.contract);
    assert.ok(workspace?.invoice);
  });

  it("persists explicit slash date ranges into workspace start/end day bounds", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const result = await ingestInquiry({
      messageText: `Harshala <harshala@example.com>
Hi Anupya,
My name is Harshala and I need DJ services for my wedding event on December 21/22 2024.
Thank you,
Harshala`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(result.eventId);
    assert.ok(workspace);
    assert.equal(workspace?.client.fullName, "Harshala");
    assert.equal(workspace?.event.eventDate, "2024-12-21");
    assert.ok(workspace?.event.workspaceStartTimestamp);
    assert.ok(workspace?.event.workspaceEndTimestamp);

    const startIso = timestampToIsoDate(workspace?.event.workspaceStartTimestamp);
    const endIso = timestampToIsoDate(workspace?.event.workspaceEndTimestamp);
    assert.equal(startIso, "2024-12-21");
    assert.equal(endIso, "2024-12-22");
  });

  it("blocks creating a new workspace when no name or contact identity is present in context", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    await assert.rejects(
      () =>
        ingestInquiry({
          messageText:
            "Hi there, I need DJ services for an event on May 1st at NYC. Please share pricing options.",
          uploadedFile: null,
        }),
      /choose an existing workspace|provide a client name|contact info/i
    );
  });

  it("blocks creating a new workspace when only name is present but no contact info", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    await assert.rejects(
      () =>
        ingestInquiry({
          messageText: `Hi Anupya,

My name is Lavanya and we're looking for a DJ for our wedding.
Can you share your availability and pricing?`,
          uploadedFile: null,
        }),
      /provide at least one contact method/i
    );
  });

  it("allows creating a new workspace when name and phone are present", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const result = await ingestInquiry({
      messageText: `Hi Anupya,

My name is Lavanya and we're looking for a DJ for our wedding.
You can text me at 917-555-2048.`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(result.eventId);
    assert.ok(workspace);
    assert.equal(workspace?.client.fullName, "Lavanya");
    assert.match((workspace?.client.phone || "").replace(/\D+/g, ""), /9175552048$/);
  });

  it("allows creating a new workspace when only contact info is present (name missing)", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const result = await ingestInquiry({
      messageText: `Hi there,

We are looking for DJ services.
You can reach me at anjali@example.com.`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(result.eventId);
    assert.ok(workspace);
    assert.equal(workspace?.client.email, "anjali@example.com");
    assert.equal(workspace?.client.fullName, "Unknown Client");
  });

  it("supports forcing context into a selected workspace when contact details are missing", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Nitya Devireddy <nitya@example.com>
Date: June 20, 2027
Location: NYC
Services needed: DJ`,
      uploadedFile: null,
    });

    const appended = await ingestInquiry({
      messageText: `Quick update from text thread:
Hey! Sorry for delay, can we confirm details tomorrow?`,
      uploadedFile: null,
      targetEventId: created.eventId,
    });

    assert.equal(appended.eventId, created.eventId);
    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace?.event.latestOcrText.includes("Quick update from text thread"));
  });

  it("allows upload-only context with OCR failure when a workspace is explicitly selected", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";
    process.env.OPENAI_API_KEY = "";

    const created = await ingestInquiry({
      messageText: `Nitya Devireddy <nitya@example.com>
Date: July 3, 2026
Location: NJ
Services needed: DJ`,
      uploadedFile: null,
    });

    const imageFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "chat.png", { type: "image/png" });
    const appended = await ingestInquiry({
      messageText: "",
      uploadedFile: imageFile,
      targetEventId: created.eventId,
    });

    assert.equal(appended.eventId, created.eventId);
    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace?.event.latestOcrText.includes("manual_transcription_required: true"));
    assert.ok(workspace?.event.latestOcrText.includes("name: chat.png"));
  });

  it("maps iMessage screenshot-style context by To: name and splits conversation entries", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";
    process.env.OPENAI_API_KEY = "";

    const created = await ingestInquiry({
      messageText: `Nitya D <nitya@example.com>
Date: July 3, 2026
Location: NJ
Services needed: DJ`,
      uploadedFile: null,
    });

    const transcript = `To: Nitya Devireddy Share your name and photo?
Anupya Nalamalapu
Yesterday 5:29 PM
Hi love, don't want to pressure you - but I've gotten another inquiry for your wedding weekend
and I just wanted to see how you were feeling! I will happily hold the date for you if you'd like, just
lmk :)

Today 5:08 PM
Hey! Apologies for the delayed response, been a tad busy with work!
We've decided to go with someone here to make the logistics easier and bring the cost down
Thank you so very much for checking in on the AV portion of things and for trying to make it all come together, we really appreciate it
No worries! I get it, hope it's everything you wanted!!
Delivered`;

    const screenshotFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "imessage.png", { type: "image/png" });
    const appended = await ingestInquiry({
      messageText: transcript,
      uploadedFile: screenshotFile,
    });

    assert.equal(appended.eventId, created.eventId);

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace);
    assert.equal(workspace?.client.fullName, "Nitya Devireddy");

    const raw = workspace?.event.latestOcrText || "";
    assert.match(raw, /\[context\][\s\S]*actor:\s*me[\s\S]*channel:\s*text/i);
    assert.match(raw, /\[context\][\s\S]*actor:\s*client[\s\S]*channel:\s*text/i);

    const meCount = [...raw.matchAll(/actor:\s*me/gi)].length;
    const clientCount = [...raw.matchAll(/actor:\s*client/gi)].length;
    assert.ok(meCount >= 2);
    assert.ok(clientCount >= 1);
  });

  it("extracts secondary client and planner/AV contacts into workspace profile from full context", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Sivani and Vara <sivani@example.com>
Hi! We're interested in DJ services for our engagement party in NYC.
Wedding planner: Priya Shah <priya@plannerco.com>
AV vendor: Sonic AV <bookings@sonicav.com>
Thanks!`,
      uploadedFile: null,
    });

    const workspace = await getWorkspaceByEventId(created.eventId);
    assert.ok(workspace?.event.profile);
    assert.equal(workspace?.event.profile?.primaryClientName, "Sivani");
    assert.equal(workspace?.event.profile?.secondaryClientName, "Vara");
    assert.equal(workspace?.event.profile?.weddingPlannerName, "Priya Shah");
    assert.equal(workspace?.event.profile?.weddingPlannerEmail, "priya@plannerco.com");
    assert.equal(workspace?.event.profile?.avVendorName, "Sonic AV");
    assert.equal(workspace?.event.profile?.avVendorEmail, "bookings@sonicav.com");
  });

  it("persists manual profile edits from workspace and keeps all key fields editable", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dj-admin-test-"));
    process.env.ADMIN_DATA_DIR = tempDir;
    process.env.ADMIN_ENABLE_CODEX_AI = "false";

    const created = await ingestInquiry({
      messageText: `Riya <riya@example.com>
Date: August 10, 2027
Location: NYC
Services needed: DJ`,
      uploadedFile: null,
    });

    const updated = await updateWorkspace({
      eventId: created.eventId,
      profile: {
        primaryClientName: "Riya Patel",
        primaryEmail: "riya@example.com",
        primaryPhone: "+1 917 555 0102",
        primaryInstagramHandle: "@riya.p",
        secondaryClientName: "Arjun Patel",
        secondaryEmail: "arjun@example.com",
        secondaryPhone: "",
        secondaryInstagramHandle: "",
        weddingPlannerName: "Meera Rao",
        weddingPlannerEmail: "meera@planner.com",
        weddingPlannerPhone: "+1 212 555 9999",
        weddingPlannerInstagramHandle: "@meera.plan",
        avVendorName: "Prime AV",
        avVendorEmail: "hello@primeav.com",
        avVendorPhone: "+1 646 555 1122",
        avVendorInstagramHandle: "@primeav",
        customFields: [{ key: "Ceremony Priest", value: "Ravi Sharma" }],
      },
    });

    assert.ok(updated?.event.profile);
    assert.equal(updated?.event.profile?.secondaryClientName, "Arjun Patel");
    assert.equal(updated?.event.profile?.weddingPlannerName, "Meera Rao");
    assert.equal(updated?.event.profile?.avVendorName, "Prime AV");
    assert.equal(updated?.event.profile?.customFields?.[0]?.key, "Ceremony Priest");
    assert.equal(updated?.event.profile?.customFields?.[0]?.value, "Ravi Sharma");
  });
});
