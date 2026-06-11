// frontend/src/invigilator/portalLink.test.ts — S-D invigilator token entry
// (vision I1 + §2.7): /invigilator?contest=slug&key=... authenticates with the
// CONTEST's invigilator_key for THAT contest only. Pure parsing/decisions; the
// portal component does the fetching.
import { describe, expect, it } from "vitest";
import { portalCredential, portalLinkOf } from "./portalLink";

describe("portalLinkOf", () => {
  it("reads contest + key from the search string, trimmed", () => {
    expect(portalLinkOf("?contest=kec-r1&key=abc123")).toEqual({ contest: "kec-r1", key: "abc123" });
    expect(portalLinkOf("?key=%20abc%20&contest=%20kec-r1%20")).toEqual({ contest: "kec-r1", key: "abc" });
  });

  it("absent params -> empty strings (the legacy password portal)", () => {
    expect(portalLinkOf("")).toEqual({ contest: "", key: "" });
    expect(portalLinkOf("?room=Lab1")).toEqual({ contest: "", key: "" });
  });

  it("a key WITHOUT a contest is ignored — keys never authenticate the legacy portal", () => {
    expect(portalLinkOf("?key=abc123")).toEqual({ contest: "", key: "" });
  });
});

describe("portalCredential", () => {
  it("tokenized link with nothing typed -> the link key", () => {
    expect(portalCredential({ contest: "kec-r1", key: "abc" }, "")).toBe("abc");
  });

  it("a TYPED password always wins (fallback after a key rejection)", () => {
    expect(portalCredential({ contest: "kec-r1", key: "abc" }, "global-pass")).toBe("global-pass");
  });

  it("legacy portal -> the typed password", () => {
    expect(portalCredential({ contest: "", key: "" }, "typed")).toBe("typed");
    expect(portalCredential({ contest: "", key: "" }, "")).toBe("");
  });
});
