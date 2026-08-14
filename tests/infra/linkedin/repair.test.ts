import { describe, it, expect } from "vitest";
import { repairMangledCard } from "@/lib/infra/linkedin/alerts";

// Every input below is a verbatim `title` value from the production database.
describe("repairMangledCard", () => {
  it("recovers location, arrangement and easyApply from an on-site card", () => {
    expect(
      repairMangledCard(
        "Full Stack Developer SourceFuse · Mohali district (On-site) Actively recruiting Easy Apply"
      )
    ).toEqual({
      title: "Full Stack Developer SourceFuse",
      location: "Mohali district (On-site)",
      arrangement: "onsite",
      easyApply: true,
    });
  });

  it("recovers a hybrid card", () => {
    expect(
      repairMangledCard(
        "Senior Full-Stack GenAI Engineer Leapfrog Technology, Inc. · Pune/Pimpri-Chinchwad Area (Hybrid)"
      )
    ).toMatchObject({ arrangement: "hybrid", easyApply: false });
  });

  it("recovers a remote card", () => {
    expect(
      repairMangledCard("Node.JS Developer Concentrix · India (Remote) Easy Apply")
    ).toMatchObject({
      location: "India (Remote)",
      arrangement: "remote",
      easyApply: true,
    });
  });

  it("strips an 'Applied on' badge", () => {
    expect(
      repairMangledCard("SDE2 Curefit · Bengaluru, Karnataka, India Applied on Aug 7")
    ).toMatchObject({ location: "Bengaluru, Karnataka, India" });
  });

  it("strips a school-alumni badge", () => {
    expect(
      repairMangledCard("Software Engineer | AI Platforms SingleStore · Pune District (Hybrid) 1 school alum")
    ).toMatchObject({ location: "Pune District (Hybrid)", arrangement: "hybrid" });
  });

  it("strips a connections badge", () => {
    expect(
      repairMangledCard("GenAI – Software Engineer III Deloitte · Pune Division 2 connections")
    ).toMatchObject({ location: "Pune Division" });
  });

  // The critical regression: this card scored 0 because "recruiting" inside a
  // badge tripped the fatal role veto.
  it("removes the badge that was tripping the role veto", () => {
    const repaired = repairMangledCard(
      "AI Developer II OpenGov Inc. · Pune Division (On-site) Actively recruiting Fast growing"
    );
    expect(repaired.title).not.toMatch(/recruiting/i);
    expect(repaired.location).toBe("Pune Division (On-site)");
  });

  it("leaves a card with no separator whole rather than guessing", () => {
    expect(repairMangledCard("Some Unparseable Card")).toEqual({
      title: "Some Unparseable Card",
      location: undefined,
      arrangement: "unknown",
      easyApply: false,
    });
  });
});
