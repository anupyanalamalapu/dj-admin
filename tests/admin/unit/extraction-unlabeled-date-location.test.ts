import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractInquiryFromText } from "../../../lib/admin/inquiries/extract";

describe("extractInquiryFromText unlabeled date/location inference", () => {
  it("infers month/day date with current year and NYC location from free-text inquiry", () => {
    const input = `Ethan and Gaby <ethanandgab@gmail.com>
4:45 PM (5 hours ago)
to me

Hi! We are exploring DJ options for a party on May 1st in NYC. The venue has DJ equipment. Would you be around from 7:30-10:30 on that night? If so what would your pricing be?

Thank you!
Gaby`;

    const output = extractInquiryFromText(input);
    const year = new Date().getFullYear();

    assert.equal(output.email, "ethanandgab@gmail.com");
    assert.equal(output.location, "NYC");
    assert.equal(output.eventDate, `${year}-05-01`);
    assert.ok(output.eventDateTimestamp);
    assert.equal(output.duration, "7:30-10:30");
    assert.ok(!output.missingFields.includes("event_date"));
    assert.ok(!output.missingFields.includes("location"));
  });

  it("extracts timeline segments from follow-up context without inventing a location", () => {
    const input = `anjali parth
Hey, thanks for getting back to me!

I’d love to hop on a call and chat more. The timeline for the wedding is -
9:00-10:00am Barat
10:00-12:00pm Wedding Ceremony
6:00-7:30pm Cocktail Hour
7:30-11:30pm Reception

I’m definitely interested in learning about pricing for dhol players & emcee services. What’s included in the $7,000-$8,000 pricing?

Thanks in advance,
Anjali Trivedi`;

    const output = extractInquiryFromText(input);

    assert.equal(output.location, undefined);
    assert.ok(!output.missingFields.includes("event_time"));
    assert.deepEqual(
      (output.timelineSegments || []).map((segment) => segment.title),
      ["Barat", "Wedding Ceremony", "Cocktail Hour", "Reception"]
    );
    assert.deepEqual(
      (output.timelineSegments || []).map((segment) => segment.time),
      ["9:00am - 10:00am", "10:00am - 12:00pm", "6:00pm - 7:30pm", "7:30pm - 11:30pm"]
    );
  });

  it("prefers wedding-intent date range from message body over email header timestamp metadata", () => {
    const input = `Shohini Gupta <gupta.shohini@gmail.com>
Wed, Jan 7, 7:12 PM
to me

Hi Anupya,

I'm getting married Sept 25-26 in DC and am starting to look for a DJ for my events.
Would love to know if you're available.

Thanks,
Shohini`;

    const output = extractInquiryFromText(input);
    const year = new Date().getFullYear();

    assert.equal(output.email, "gupta.shohini@gmail.com");
    assert.equal(output.location, "DC");
    assert.equal(output.eventDate, `${year}-09-25`);
    assert.equal(output.eventEndDate, `${year}-09-26`);
    assert.ok(output.missingFields.includes("event_time"));
  });

  it("parses title-first timeline rows with weekday mapping across a known date range", () => {
    const input = `Shohini Gupta <gupta.shohini@gmail.com>
Hi Anupya,
I'm getting married Sept 25-26 in DC.

Hours:
Friday
Welcome Party on Friday - 3-7PM, programming + 1 hr dance floor.
Saturday
Ceremony - 3-5pm
Cocktail hour - 5-7 pm
Reception - 7-11pm`;

    const output = extractInquiryFromText(input);
    const year = new Date().getFullYear();

    assert.equal(output.eventDate, `${year}-09-25`);
    assert.equal(output.eventEndDate, `${year}-09-26`);
    assert.deepEqual(
      (output.timelineSegments || []).map((segment) => segment.title),
      ["Welcome Party", "Ceremony", "Cocktail hour", "Reception"]
    );
    assert.deepEqual(
      (output.timelineSegments || []).map((segment) => segment.time),
      ["3:00pm - 7:00pm", "3:00pm - 5:00pm", "5:00pm - 7:00pm", "7:00pm - 11:00pm"]
    );
    assert.deepEqual(
      (output.timelineSegments || []).map((segment) => segment.date),
      [`${year}-09-25`, `${year}-09-26`, `${year}-09-26`, `${year}-09-26`]
    );
    assert.equal(output.location, "DC");
  });

  it("parses 24-hour timeline ranges that roll into the next day", () => {
    const input = `Lavanya <lavanya@example.com>
Event type: Wedding
Date: January 31, 2027
Location: NYC
Core Performance - 19:00-00:00`;

    const output = extractInquiryFromText(input);
    assert.equal(output.eventDate, "2027-01-31");
    assert.deepEqual(
      (output.timelineSegments || []).map((segment) => segment.time),
      ["19:00 - 0:00"]
    );
    assert.ok(!output.missingFields.includes("event_time"));
  });

  it("does not use inquiry header timestamps as event dates when body has no explicit event date", () => {
    const input = `Lavanya and Pranav <pranavandlavanya@lavanav.com>
Feb 26, 2026, 2:30 PM (9 days ago)
to me

Hi Anupya,
We are planning our wedding and exploring DJs. We'd love to connect and learn more about your process.

Thanks,
Pranav`;

    const output = extractInquiryFromText(input);
    assert.equal(output.email, "pranavandlavanya@lavanav.com");
    assert.equal(output.clientName, "Pranav");
    assert.equal(output.eventDate, undefined);
    assert.equal(output.eventDateTimestamp, undefined);
    assert.ok(output.missingFields.includes("event_date"));
  });

  it("maps weekday-prefixed timeline rows to the correct dates inside a multi-day range", () => {
    const input = `Sivani and Vara <sivani@example.com>
Event type: Wedding
Date: Oct 29-31
Location: Dallas

Thursday Night Welcome Dinner 8:30 PM - 12 PM (First hour ish just for cocktails, mingling)
Friday Morning Haldi 11:30 AM - 2 PM (First hour ish just for brunch)
Saturday Morning Ceremony 9 AM - 12 PM (Baaraat, Groom entrance, bridal entrance, talambralu playlist)
Saturday Reception 8 PM - 2 AM (Dance performances, open dance floor)`;

    const output = extractInquiryFromText(input);
    const year = new Date().getFullYear();

    assert.equal(output.eventDate, `${year}-10-29`);
    assert.equal(output.eventEndDate, `${year}-10-31`);
    assert.equal((output.timelineSegments || []).length, 4);
    assert.deepEqual(
      (output.timelineSegments || []).map((segment) => segment.date),
      [`${year}-10-29`, `${year}-10-30`, `${year}-10-31`, `${year}-10-31`]
    );
  });

  it("infers named events with shared times and carries per-event vibe notes from follow-up context", () => {
    const year = new Date().getFullYear();
    const input = `Harshala <bhwedding90@gmail.com>
Initial inquiry:
Date: December 21/22 ${year}
Location: Cancun, Mexico

Follow-up:
It’s a Hindu - Catholic wedding. On 21st we have the Sangeet and 22nd is the reception.
Both the events are from 7pm to 11pm.
It’s in Cancun, Mexico.
For the Sangeet- we would have some family and friends performing followed by dancing so looking at Bollywood/ hip hop music.
For the reception- hip hop/ rap`;

    const output = extractInquiryFromText(input);
    assert.equal(output.location, "Cancun, Mexico");
    assert.equal(output.eventDate, `${year}-12-21`);
    assert.equal(output.eventEndDate, `${year}-12-22`);

    const timeline = output.timelineSegments || [];
    const byTitle = new Map(timeline.map((segment) => [segment.title.toLowerCase(), segment]));
    assert.equal(byTitle.get("sangeet")?.date, `${year}-12-21`);
    assert.equal(byTitle.get("reception")?.date, `${year}-12-22`);
    assert.match((byTitle.get("sangeet")?.time || "").replace(/\s+/g, "").toLowerCase(), /^7:00pm-11:00pm$/);
    assert.match((byTitle.get("reception")?.time || "").replace(/\s+/g, "").toLowerCase(), /^7:00pm-11:00pm$/);
    assert.match((byTitle.get("sangeet")?.notes || "").toLowerCase(), /bollywood.*hip hop/);
    assert.match((byTitle.get("reception")?.notes || "").toLowerCase(), /hip hop\/ rap/);
  });

  it("does not treat email domains as instagram handles", () => {
    const input = `Maya Patel <maya@example.com>
Date: May 2nd, 2027
Location: SF
Services needed: DJ`;

    const output = extractInquiryFromText(input);
    assert.equal(output.email, "maya@example.com");
    assert.equal(output.instagramHandle, undefined);
  });

  it("extracts two-day corporate event dates from message body and keeps header timestamp as context metadata only", () => {
    const year = new Date().getFullYear();
    const input = `Kyle Gaillard <kyle@nounagency.com>
Tue, Feb 24, 6:22 AM (12 days ago)
to me

Hi,

Reaching out because we’re producing an event in NYC on March 26th and 27th.
We’re looking to source DJs for both nights and would like to connect.`;

    const output = extractInquiryFromText(input);

    assert.equal(output.email, "kyle@nounagency.com");
    assert.equal(output.clientName, "Kyle Gaillard");
    assert.equal(output.location, "NYC");
    assert.equal(output.eventDate, `${year}-03-26`);
    assert.equal(output.eventEndDate, `${year}-03-27`);
    assert.ok(output.missingFields.includes("event_time"));
  });

  it("semantically extracts straightforward prose inquiry details from OCR/email text", () => {
    const year = new Date().getFullYear();
    const input = `Taylor Robinson <tjrobinson@createcultivate.com>
Thu, Mar 5, 8:20 AM (3 days ago)
to me

Hi there!

I hope you’re doing well. We’re taking over GATHER Espresso Bar + Wine Bar this Sunday on March 8 to celebrate International Women’s Day and are looking for a DJ to help set the tone for the evening afternoon portion of the activation from 1 to 3pm.`;

    const output = extractInquiryFromText(input);

    assert.equal(output.clientName, "Taylor Robinson");
    assert.equal(output.email, "tjrobinson@createcultivate.com");
    assert.equal(output.eventType, "Event");
    assert.equal(output.location, "GATHER Espresso Bar + Wine Bar");
    assert.equal(output.eventDate, `${year}-03-08`);
    assert.equal(output.duration, "1:00pm - 3:00pm");
    assert.ok(!output.missingFields.includes("event_date"));
    assert.ok(!output.missingFields.includes("event_time"));
    assert.ok(!output.missingFields.includes("location"));
  });

  it("detects multiple explicit dated event lines with parenthesized time windows", () => {
    const year = new Date().getFullYear();
    const input = `Nitya Aziz <aziznitya25@gmail.com>
Hi Anupya,

I’m getting married this July and would love to check your availability for our events at the InterContinental Boston.

July 3rd (7:00 pm – 10:00 pm) – Cocktail Night
July 4th (9:30 am – 1:30 pm) – Baraat & Wedding Ceremony
July 4th (7:00 pm – 1:30 am) – Reception`;

    const output = extractInquiryFromText(input);

    assert.equal(output.email, "aziznitya25@gmail.com");
    assert.ok((output.location || "").toLowerCase().includes("boston"));
    assert.equal(output.eventDate, `${year}-07-03`);
    assert.ok(!output.missingFields.includes("event_time"));
    assert.equal((output.timelineSegments || []).length, 3);
    assert.deepEqual(
      (output.timelineSegments || []).map((segment) => segment.title),
      ["Cocktail Night", "Baraat & Wedding Ceremony", "Reception"]
    );
    assert.deepEqual(
      (output.timelineSegments || []).map((segment) => segment.date),
      [`${year}-07-03`, `${year}-07-04`, `${year}-07-04`]
    );
    assert.deepEqual(
      (output.timelineSegments || []).map((segment) => segment.time),
      ["7:00pm - 10:00pm", "9:30am - 1:30pm", "7:00pm - 1:30am"]
    );
  });

  it("detects multi-event timelines from sentence-format prose (not just line blocks)", () => {
    const year = new Date().getFullYear();
    const input = `Nitya Aziz <aziznitya25@gmail.com>
Hi Anupya,

Our wedding weekend events are Cocktail Night on July 3 from 7:00 pm to 10:00 pm, Baraat & Wedding Ceremony on July 4 from 9:30 am to 1:30 pm, and on July 4 from 7:00 pm to 1:30 am for Reception at the InterContinental Boston.`;

    const output = extractInquiryFromText(input);

    assert.equal(output.email, "aziznitya25@gmail.com");
    assert.ok((output.location || "").toLowerCase().includes("boston"));
    assert.equal(output.eventDate, `${year}-07-03`);
    assert.equal((output.timelineSegments || []).length, 3);
    assert.deepEqual(
      (output.timelineSegments || []).map((segment) => segment.title),
      ["Cocktail Night", "Baraat & Wedding Ceremony", "Reception"]
    );
    assert.deepEqual(
      (output.timelineSegments || []).map((segment) => segment.date),
      [`${year}-07-03`, `${year}-07-04`, `${year}-07-04`]
    );
    assert.deepEqual(
      (output.timelineSegments || []).map((segment) => segment.time),
      ["7:00pm - 10:00pm", "9:30am - 1:30pm", "7:00pm - 1:30am"]
    );
  });
});
