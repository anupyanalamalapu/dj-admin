import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderContract, renderContractHtml } from "../../../lib/admin/contracts/generate";
import { ContractDynamicFields } from "../../../lib/admin/types/models";

describe("contract template renderer", () => {
  it("renders deterministic static wording with dynamic replacements", () => {
    const fields: ContractDynamicFields = {
      eventDetails: [
        {
          id: "detail_1",
          title: "Wedding",
          date: "2027-05-23",
          time: "5:00 pm - 10:00 pm",
          location: "The Rockleigh, Rockleigh, New Jersey",
          amount: 3000,
        },
      ],
      travelAmount: 500,
      totalAmount: 0,
      depositAmount: 0,
      remainingAmount: 0,
      dueDate: "2027-05-01",
      cancellationDate: "2027-04-01",
    };

    const rendered = renderContract(
      fields,
      "Additional Terms\nNo outside recording allowed.\n\nSIGNATURES\nClient Signature: ________\nDJ Signature: ________",
      "Anjali Trivedi"
    );
    assert.match(rendered.renderedText, /DJ Wedding Contract/);
    assert.match(rendered.renderedText, /Contracting Party: Anjali Trivedi/);
    assert.match(rendered.renderedText, /custom musical entertainment/i);
    assert.match(rendered.renderedText, /\$3,500/);
    assert.match(rendered.renderedText, /\$875/);
    assert.match(rendered.renderedText, /\$2,625/);
    assert.match(rendered.renderedText, /May 23, 2027/);
    assert.doesNotMatch(rendered.renderedText, /\nSIGNATURES\n/i);

    const html = renderContractHtml({
      clientName: "Anjali Trivedi",
      fields: rendered.normalizedFields,
      legalBody: "Additional Terms\nNo outside recording allowed.\n\nSIGNATURES\nClient Signature: ________",
    });

    assert.match(html, /DJ Wedding Contract/);
    assert.match(html, /Contracting Party:<\/strong> <span class="dyn">Anjali Trivedi<\/span>/);
    assert.match(html, /from <span class="dyn">5:00 pm - 10:00 pm<\/span>/);
    assert.match(html, /\.dyn\s*\{\s*color:\s*#1d4ed8;/);
    assert.match(html, /No outside recording allowed/);
    assert.match(html, /May 23, 2027/);
    assert.doesNotMatch(html, /SIGNATURES/);
  });

  it("renders manual override pricing with struck-through base amount and uses override for totals", () => {
    const fields: ContractDynamicFields = {
      eventDetails: [
        {
          id: "detail_1",
          title: "Wedding",
          date: "2027-05-23",
          time: "5:00 pm - 10:00 pm",
          location: "The Rockleigh, Rockleigh, New Jersey",
          amount: 3000,
          manualOverridePrice: 2400,
        },
      ],
      travelAmount: 500,
      totalAmount: 0,
      depositAmount: 0,
      remainingAmount: 0,
      dueDate: "2027-05-01",
      cancellationDate: "2027-04-01",
    };

    const rendered = renderContract(fields, "Additional Terms", "Anjali Trivedi");
    assert.match(rendered.renderedText, /~~\$3,000~~ \$2,400/);
    assert.match(rendered.renderedText, /\$2,900/);
    assert.match(rendered.renderedText, /\$725/);
    assert.match(rendered.renderedText, /\$2,175/);

    const html = renderContractHtml({
      clientName: "Anjali Trivedi",
      fields: rendered.normalizedFields,
      legalBody: "Additional Terms",
    });
    assert.match(html, /<span class="strike">\$3,000<\/span>\$2,400/);
  });
});
