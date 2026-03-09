import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coerceExtractedLocationToCity, coerceLocationToCity, normalizeLocationCandidate } from "../../../lib/admin/inquiries/location";

describe("location coercion", () => {
  it("keeps city-like locations without API lookup", async () => {
    let called = false;
    const fakeFetch: typeof fetch = (async () => {
      called = true;
      throw new Error("should not be called");
    }) as typeof fetch;

    const output = await coerceLocationToCity({
      location: "Miami",
      fetchImpl: fakeFetch,
    });

    assert.equal(output.location, "Miami");
    assert.equal(output.verified, true);
    assert.equal(called, false);
  });

  it("uses public geocoding data to coerce venue-style text to city-level location", async () => {
    const priorFlag = process.env.ADMIN_ENABLE_LOCATION_API;
    process.env.ADMIN_ENABLE_LOCATION_API = "true";
    const fakeFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.includes("nominatim.openstreetmap.org")) {
        return new Response(JSON.stringify({ features: [] }), { status: 200 });
      }
      return new Response(
        JSON.stringify([
          {
            address: {
              city: "Rockleigh",
              state: "New Jersey",
              country: "United States",
              country_code: "us",
            },
          },
        ]),
        { status: 200 }
      );
    }) as typeof fetch;

    try {
      const output = await coerceLocationToCity({
        location: "The Rockleigh, New Jersey",
        fetchImpl: fakeFetch,
      });

      assert.equal(output.location, "Rockleigh, NJ");
      assert.equal(output.verified, true);
    } finally {
      if (typeof priorFlag === "string") {
        process.env.ADMIN_ENABLE_LOCATION_API = priorFlag;
      } else {
        delete process.env.ADMIN_ENABLE_LOCATION_API;
      }
    }
  });

  it("treats state-only values as missing location", async () => {
    const output = await coerceLocationToCity({
      location: "New Jersey",
    });
    assert.equal(output.location, undefined);
    assert.equal(output.verified, false);
  });

  it("updates extracted missingFields when location cannot be used", async () => {
    const extracted = await coerceExtractedLocationToCity({
      extracted: {
        clientName: "Test User",
        email: "test@example.com",
        phone: undefined,
        instagramHandle: undefined,
        eventType: "Wedding",
        eventLabel: undefined,
        eventDate: "2027-05-23",
        eventDateTimestamp: 1811030400000,
        eventEndDate: "2027-05-23",
        eventEndDateTimestamp: 1811030400000,
        location: "NJ",
        servicesRequested: ["dj"],
        guestCount: 120,
        duration: "7:00pm - 11:00pm",
        timelineSegments: [],
        missingFields: [],
      },
    });

    assert.equal(extracted.location, undefined);
    assert.ok(extracted.missingFields.includes("location"));
  });

  it("defaults ambiguous venue-only locations to NYC before geocoder guess", async () => {
    const priorFlag = process.env.ADMIN_ENABLE_LOCATION_API;
    process.env.ADMIN_ENABLE_LOCATION_API = "true";
    const fakeFetch: typeof fetch = (async () => {
      return new Response(JSON.stringify([]), { status: 200 });
    }) as typeof fetch;
    try {
      const output = await coerceLocationToCity({
        location: "Some Random Ballroom Name",
        fetchImpl: fakeFetch,
      });
      assert.equal(output.location, "NYC");
      assert.equal(output.verified, false);
    } finally {
      if (typeof priorFlag === "string") {
        process.env.ADMIN_ENABLE_LOCATION_API = priorFlag;
      } else {
        delete process.env.ADMIN_ENABLE_LOCATION_API;
      }
    }
  });

  it("normalizes and rejects non-location snippets", () => {
    assert.equal(normalizeLocationCandidate("Thanks in advance"), undefined);
    assert.equal(normalizeLocationCandidate("Park Chateau, New Jersey"), "Park Chateau, New Jersey");
  });
});
