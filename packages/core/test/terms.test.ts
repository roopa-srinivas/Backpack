import { describe, expect, it } from "vitest";
import { courseTerm, currentTerm, isEarlierTerm, newestFirst, newestTerm, parseTerm, termName } from "../src/index.js";

const at = (date: string) => Date.parse(`${date}T12:00:00Z`);

describe("terms", () => {
  it("reads terms the way each site writes them", () => {
    expect(parseTerm("Fall 2026")).toEqual({ season: "Fall", year: 2026 });
    expect(parseTerm("2027 Spring")).toEqual({ season: "Spring", year: 2027 });
    expect(parseTerm("CS 61C: Great Ideas in Computer Architecture, Summer 2026")).toEqual({ season: "Summer", year: 2026 });
    expect(parseTerm("Autumn 2026")).toEqual({ season: "Fall", year: 2026 });
    expect(parseTerm("COMPSCI 61A - LEC 001")).toBeNull();
    expect(parseTerm("Default Term")).toBeNull();
    expect(parseTerm(undefined)).toBeNull();
  });

  it("knows which term is going on", () => {
    expect(termName(currentTerm(at("2026-11-04")))).toBe("Fall 2026");
    expect(termName(currentTerm(at("2026-12-28")))).toBe("Fall 2026"); // winter break
    expect(termName(currentTerm(at("2027-01-05")))).toBe("Winter 2027");
    expect(termName(currentTerm(at("2027-01-20")))).toBe("Spring 2027");
    expect(termName(currentTerm(at("2027-06-10")))).toBe("Summer 2027");
    expect(termName(currentTerm(at("2027-08-20")))).toBe("Fall 2027");
  });

  it("treats past terms as earlier, and current, upcoming or unknown ones as not", () => {
    const now = at("2026-11-04");
    expect(isEarlierTerm(parseTerm("Spring 2026"), now)).toBe(true);
    expect(isEarlierTerm(parseTerm("Fall 2025"), now)).toBe(true);
    expect(isEarlierTerm(parseTerm("Fall 2026"), now)).toBe(false);
    expect(isEarlierTerm(parseTerm("Spring 2027"), now)).toBe(false); // signed up early
    expect(isEarlierTerm(null, now)).toBe(false);
    // Over winter break, fall classes still show next to spring ones.
    expect(isEarlierTerm(parseTerm("Fall 2026"), at("2026-12-28"))).toBe(false);
    expect(isEarlierTerm(parseTerm("Fall 2026"), at("2027-01-20"))).toBe(true);
  });

  it("finds a course's term from what the site says or from its name", () => {
    expect(courseTerm({ platform: "canvas", id: "1", name: "COMPSCI 61A - LEC 001", term: "Fall 2026" })).toEqual({ season: "Fall", year: 2026 });
    expect(courseTerm({ platform: "prairielearn", id: "2", name: "CS 61C: Great Ideas, Spring 2026" })).toEqual({ season: "Spring", year: 2026 });
    expect(courseTerm({ platform: "canvas", id: "3", name: "Writing Seminar" })).toBeNull();
  });

  it("picks the newest term across copies and sorts newest first", () => {
    const copies = [
      { platform: "canvas" as const, id: "1", name: "CS 61A", term: "Spring 2026" },
      { platform: "gradescope" as const, id: "2", name: "CS 61A", term: "Fall 2026" },
      { platform: "canvas" as const, id: "3", name: "CS 61A" },
    ];
    expect(newestTerm(copies)).toEqual({ season: "Fall", year: 2026 });
    const terms = ["Spring 2026", "Fall 2026", null, "Fall 2025"].map((t) => (t ? parseTerm(t) : null));
    expect(terms.sort(newestFirst).map((t) => (t ? termName(t) : null))).toEqual(["Fall 2026", "Spring 2026", "Fall 2025", null]);
  });
});
