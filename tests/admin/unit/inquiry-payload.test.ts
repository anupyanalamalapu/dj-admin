import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildInquiryProcessingPayload,
  extractToLineName,
  extractSenderFromHeader,
  extractSignatureName,
  toInquiryProcessingJson,
} from "../../../lib/admin/inquiries/payload";

describe("inquiry payload helpers", () => {
  it("extracts sender and signature hints", () => {
    const message = `anjali parth <anjali.parth.wedding@gmail.com>
11:56 AM

Hello there

Best,
Anjali Trivedi`;

    const sender = extractSenderFromHeader(message);
    const signature = extractSignatureName(message);

    assert.equal(sender.senderEmailHint, "anjali.parth.wedding@gmail.com");
    assert.equal(sender.senderNameHint, "Anjali Parth");
    assert.equal(signature, "Anjali Trivedi");
  });

  it("builds deterministic JSON payload for downstream services", () => {
    const payload = buildInquiryProcessingPayload({
      messageText: `anjali parth <anjali.parth.wedding@gmail.com>
Best,
Anjali Trivedi`,
      ocrText: "Date: May 23rd, 2027",
    });

    const jsonText = toInquiryProcessingJson(payload);
    const parsed = JSON.parse(jsonText) as {
      rawText: string;
      ocrText: string;
      combinedText: string;
      hints: {
        senderEmailHint: string;
        senderNameHint: string;
        signatureNameHint: string;
      };
    };

    assert.match(parsed.combinedText, /Date: May 23rd, 2027/);
    assert.equal(parsed.hints.senderEmailHint, "anjali.parth.wedding@gmail.com");
    assert.equal(parsed.hints.signatureNameHint, "Anjali Trivedi");
  });

  it("extracts iMessage recipient name from To: line and ignores UI status words", () => {
    const message = `To: Nitya Devireddy Share your name and photo?
Yesterday 5:29 PM
Hi love, don't want to pressure you...
Delivered`;

    const sender = extractSenderFromHeader(message);
    const toLine = extractToLineName(message);
    const signature = extractSignatureName(message);

    assert.equal(toLine, "Nitya Devireddy");
    assert.equal(sender.senderNameHint, "Nitya Devireddy");
    assert.notEqual(signature, "Delivered");
  });
});
