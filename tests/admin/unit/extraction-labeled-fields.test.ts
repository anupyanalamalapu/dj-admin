import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractInquiryFromText } from "../../../lib/admin/inquiries/extract";
import { formatDateLong } from "../../../lib/admin/utils/date";

describe("extractInquiryFromText labeled fields", () => {
  it("parses labeled inquiry fields and timestamp date", () => {
    const input = `anjali parth <anjali.parth.wedding@gmail.com>
11:56 AM (9 hours ago)
to me

Hey Anupya,

I’m reaching out to inquire about DJ services & pricing for my wedding.

Here are a few details about the event:

• Event type: Indian wedding ceremony + reception
• Estimated guest count: ~300 guests
• Date: May 23rd, 2027
• Location: The Rockleigh, Rockleigh, New Jersey
• Services needed: Ceremony, cocktail hour, and reception DJ/MC

Could you please share your pricing, package options, and what services are included? Do you offer additional services such as lighting, baraat setup, or dhol players?

Thank you, and I look forward to hearing from you!

Best,
Anjali Trivedi`;

    const output = extractInquiryFromText(input);

    assert.equal(output.clientName, "Anjali Trivedi");
    assert.equal(output.email, "anjali.parth.wedding@gmail.com");
    assert.equal(output.eventType, "Wedding");
    assert.equal(output.location, "The Rockleigh, Rockleigh, New Jersey");
    assert.ok(output.eventDateTimestamp);
    assert.equal(formatDateLong({ timestamp: output.eventDateTimestamp, isoDate: output.eventDate }), "May 23, 2027");
    assert.ok(output.servicesRequested.includes("dj"));
    assert.ok(output.servicesRequested.includes("mc"));
    assert.ok(output.servicesRequested.includes("lighting"));
    assert.ok(output.servicesRequested.includes("dhol"));
    assert.ok(output.servicesRequested.includes("baraat setup"));
    assert.ok(!output.missingFields.includes("event_date"));
  });

  it("prefers latest labeled values when multiple context blocks are appended", () => {
    const input = `Event type: Wedding
Date: May 23rd, 2027
Location: The Rockleigh, New Jersey
Services needed: DJ

----- New Inquiry -----

Event type: Reception
Date: May 24th, 2027
Location: Park Chateau, New Jersey
Services needed: DJ, MC`;

    const output = extractInquiryFromText(input);
    assert.equal(output.eventType, "Event");
    assert.equal(output.eventDate, "2027-05-24");
    assert.equal(output.location, "Park Chateau, New Jersey");
    assert.ok(output.servicesRequested.includes("dj"));
    assert.ok(output.servicesRequested.includes("mc"));
  });
});
