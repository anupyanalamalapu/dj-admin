import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractInquiryFromText } from "../../../lib/admin/inquiries/extract";
import { buildInquiryProcessingPayload } from "../../../lib/admin/inquiries/payload";

describe("extractInquiryFromText client-name selection", () => {
  it("prefers signature name over sender header alias", () => {
    const input = `anjali parth <anjali.parth.wedding@gmail.com>
Hi Anupya,
Date: May 23rd, 2027
Location: The Rockleigh, Rockleigh, New Jersey

Best,
Anjali Trivedi`;

    const payload = buildInquiryProcessingPayload({ messageText: input });
    const output = extractInquiryFromText(payload.combinedText, payload);

    assert.equal(output.clientName, "Anjali Trivedi");
  });

  it("falls back to sender header when no signature is present", () => {
    const input = `Sarah Lee <sarah@example.com>
Hi, wedding inquiry for September 26, 2026 at Vanderbilt Museum.`;

    const payload = buildInquiryProcessingPayload({ messageText: input });
    const output = extractInquiryFromText(payload.combinedText, payload);

    assert.equal(output.clientName, "Sarah Lee");
  });

  it("retains header contact hints while not treating header timestamp as event date", () => {
    const input = `Lavanya and Pranav <pranavandlavanya@lavanav.com>
Feb 26, 2026, 2:30 PM (9 days ago)
to me

Hi Anupya,
We're planning our wedding and exploring DJs.`;

    const payload = buildInquiryProcessingPayload({ messageText: input });
    const output = extractInquiryFromText(payload.combinedText, payload);

    assert.equal(output.email, "pranavandlavanya@lavanav.com");
    assert.equal(output.clientName, "Lavanya And Pranav");
    assert.equal(output.eventDate, undefined);
    assert.equal(output.eventDateTimestamp, undefined);
  });

  it("extracts single-word explicit name and slash date range", () => {
    const input = `Hi Anupya,

My name is Harshala and I came across your profile on instagram and I really like your work.
I would like to get information for DJ services for my wedding event on December 21/22 2024.

Thank you,
Harshala`;

    const payload = buildInquiryProcessingPayload({ messageText: input });
    const output = extractInquiryFromText(payload.combinedText, payload);

    assert.equal(output.clientName, "Harshala");
    assert.equal(output.eventDate, "2024-12-21");
    assert.equal(output.eventEndDate, "2024-12-22");
    assert.ok(output.eventDateTimestamp);
    assert.ok(output.eventEndDateTimestamp);
  });

  it("uses To-line recipient name for text-message OCR style input and ignores Delivered", () => {
    const input = `To: Nitya Devireddy Share your name and photo?
Anupya Nalamalapu
Yesterday 5:29 PM
Hi love, don't want to pressure you - but I've gotten another inquiry for your wedding weekend
and I just wanted to see how you were feeling! I will happily hold the date for you if you'd like, just
lmk :)

Today 5:08 PM
Hey! Apologies for the delayed response, been a tad busy with work!
We've decided to go with someone here to make the logistics easier and bring the cost down.
Delivered`;

    const payload = buildInquiryProcessingPayload({ messageText: input });
    const output = extractInquiryFromText(payload.combinedText, payload);

    assert.equal(output.clientName, "Nitya Devireddy");
    assert.equal(output.email, undefined);
    assert.equal(output.phone, undefined);
    assert.equal(output.instagramHandle, undefined);
  });

  it("extracts instagram top-header name/handle and event details from screenshot-style text", () => {
    const input = `Rajat Batta
rajat_rocky_batta

Hey Anupya! Are you available April 18th to DJ @nddlofficial in Las Vegas?
We are hosting our Nationals.
Possible to share your number?`;

    const payload = buildInquiryProcessingPayload({ messageText: input });
    const output = extractInquiryFromText(payload.combinedText, payload);

    assert.equal(output.clientName, "Rajat Batta");
    assert.equal(output.instagramHandle, "@rajat_rocky_batta");
    assert.ok(output.eventDate);
    assert.ok(output.eventDateTimestamp);
  });

  it("does not infer instagram handle from @mentions when inquiry is clearly email-based", () => {
    const input = `Taylor Robinson <tjrobinson@createcultivate.com>
Hi there - can you share availability?
We'll also be posting across Instagram and tagging @hlight.`;

    const payload = buildInquiryProcessingPayload({ messageText: input });
    const output = extractInquiryFromText(payload.combinedText, payload);

    assert.equal(output.email, "tjrobinson@createcultivate.com");
    assert.equal(output.instagramHandle, undefined);
  });
});
