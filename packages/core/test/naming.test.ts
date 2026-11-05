import { describe, expect, it } from "vitest";
import { courseCodes, mergeAssignments, parseTerm, type Assignment, type Course } from "../src/index.js";

/**
 * How courses get named in the wild, across bCourses, Gradescope and
 * PrairieLearn. Each case lists the platform copies and which of them are the
 * same class; anything not listed together must stay apart.
 */

type Copy = [id: string, platform: Course["platform"], name: string, extra?: { code?: string; term?: string }];

let n = 0;
/** One assignment per copy, each with its own title, so only the course decides the grouping. */
function classes(copies: Copy[]): string[][] {
  const assignments: Assignment[] = copies.map(([id, platform, name, extra]) => ({
    platform,
    id: `a${++n}`,
    course: { platform, id, name, ...extra },
    title: `Thing ${id}`,
    url: "https://example.edu",
    dueAt: "2026-10-01T06:59:00Z",
    submitted: false,
    kind: "assignment",
    points: null,
  }));
  const groups = new Map<string, Set<string>>();
  for (const task of mergeAssignments(assignments)) {
    for (const source of task.sources) groups.set(task.courseKey, (groups.get(task.courseKey) ?? new Set()).add(source.course.id));
  }
  return [...groups.values()].map((ids) => [...ids].sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));
}

const sorted = (groups: string[][]) => groups.map((g) => [...g].sort()).sort((a, b) => a[0]!.localeCompare(b[0]!));

describe("one class, however it's written", () => {
  const cases: [string, Copy[]][] = [
    [
      "CS 61A",
      [
        ["1", "canvas", "COMPSCI 61A - LEC 001", { code: "COMPSCI 61A", term: "Fall 2026" }],
        ["2", "gradescope", "CS 61A Fall 2026", { code: "CS 61A" }],
        ["3", "gradescope", "Structure and Interpretation of Computer Programs", { code: "CS61A FA26" }],
        ["4", "prairielearn", "CS 61A: Structure and Interpretation of Computer Programs, Fall 2026"],
        ["5", "gradescope", "cs61a", { code: "cs61a" }],
        ["6", "canvas", "Intro to CS 61A (Fall '26)"],
        ["7", "gradescope", "Computer Science 61A"],
        ["8", "canvas", "COMPSCI 61A-001 Fall Semester 2026"],
      ],
    ],
    [
      "Physics 7A, department written short and long",
      [
        ["1", "canvas", "PHYSICS 7A - LEC 002", { code: "PHYSICS 7A", term: "Fall 2026" }],
        ["2", "gradescope", "Phys 7A", { code: "PHYS 7A", term: "Fall 2026" }],
        ["3", "prairielearn", "Physics 7A: Physics for Scientists and Engineers, Fall 2026"],
      ],
    ],
    [
      "EECS 16A / EE 16A / EL ENG 16A",
      [
        ["1", "canvas", "EECS 16A - LEC 001", { code: "EECS 16A", term: "Fall 2026" }],
        ["2", "gradescope", "EE 16A Fall 2026", { code: "EE 16A" }],
        ["3", "prairielearn", "EL ENG 16A: Designing Information Devices and Systems, Fall 2026"],
      ],
    ],
    [
      "Data 100, cross-listed three ways",
      [
        ["1", "canvas", "DATA C100/COMPSCI C100/STAT C100 - LEC 001", { term: "Fall 2026" }],
        ["2", "gradescope", "Data 100", { code: "DATA 100", term: "Fall 2026" }],
        ["3", "gradescope", "Stat C100", { code: "STAT C100", term: "Fall 2026" }],
        ["4", "prairielearn", "CS C100: Principles and Techniques of Data Science, FA26"],
      ],
    ],
    [
      "EECS C106A / ME 106A, term written differently on each site",
      [
        ["1", "canvas", "EECS C106A - LEC 001", { code: "EECS C106A", term: "Fall Semester 2026" }],
        ["2", "gradescope", "ME 106A", { code: "ME 106A", term: "FA26" }],
      ],
    ],
    [
      "CS 169 / CS 169A, with terms written short (a real account)",
      [
        ["1", "canvas", "Introduction to Software Engineering (Fall 2026)", { code: "CS169A Fall 2026", term: "Fall 2026" }],
        ["2", "gradescope", "Introduction to Software Engineering (Fall 2026)", { code: "CS169A FA26", term: "Fall 2026" }],
        ["3", "prairielearn", "CS 169: Introduction to Software Engineering, CS169A Fall 26", { code: "CS 169" }],
      ],
    ],
    [
      "Honors and reading-and-composition numbers",
      [
        ["1", "canvas", "MATH H54 - LEC 001", { term: "Fall 2026" }],
        ["2", "gradescope", "Math H54", { code: "MATH H54", term: "Fall 2026" }],
      ],
    ],
    [
      "Special topics with a topic number",
      [
        ["1", "canvas", "COMPSCI 194-26 - LEC 001", { term: "Fall 2026" }],
        ["2", "gradescope", "CS194-26 Computational Photography", { code: "CS194-26" }],
      ],
    ],
    [
      "A two-word department",
      [
        ["1", "canvas", "ETH STD 21AC - LEC 001", { term: "Fall 2026" }],
        ["2", "gradescope", "Ethnic Studies", { code: "ETH STD 21AC" }],
      ],
    ],
  ];

  for (const [name, copies] of cases) {
    it(name, () => {
      expect(classes(copies)).toEqual([copies.map(([id]) => id).sort()]);
    });
  }
});

describe("different classes stay apart", () => {
  const cases: [string, Copy[], string[][]][] = [
    [
      "CS 160 and CS 169A, from a real account",
      [
        ["1", "canvas", "User Interface Design and Development (Fall 2026)", { code: "CS160 (Fall26)", term: "Fall 2026" }],
        ["2", "canvas", "Introduction to Software Engineering (Fall 2026)", { code: "CS169A Fall 2026", term: "Fall 2026" }],
        ["3", "prairielearn", "CS 169: Introduction to Software Engineering, CS169A Fall 26", { code: "CS 169" }],
      ],
      [["1"], ["2", "3"]],
    ],
    ["CS 61A and CS 61B", [["1", "canvas", "COMPSCI 61A - LEC 001"], ["2", "gradescope", "CS 61B"]], [["1"], ["2"]]],
    ["MATH 1A and MATH 1B", [["1", "canvas", "MATH 1A - LEC 001"], ["2", "gradescope", "Math 1B"]], [["1"], ["2"]]],
    ["CHEM 1A and MATH 1A, same number", [["1", "canvas", "CHEM 1A - LEC 001"], ["2", "gradescope", "MATH 1A"]], [["1"], ["2"]]],
    ["MATH 54 and honors MATH H54", [["1", "canvas", "MATH 54 - LEC 001"], ["2", "gradescope", "Math H54"]], [["1"], ["2"]]],
    ["CS 194-26 and CS 194-15", [["1", "canvas", "COMPSCI 194-26 - LEC 001"], ["2", "gradescope", "CS 194-15"]], [["1"], ["2"]]],
    ["CS 10 and CS 100", [["1", "canvas", "COMPSCI 10 - LEC 001"], ["2", "gradescope", "CS 100"]], [["1"], ["2"]]],
    [
      "CS 61A and CS 88 sharing one bCourses site",
      [["1", "canvas", "COMPSCI 61A/COMPSCI 88 - LEC 001"], ["2", "gradescope", "CS 88"]],
      [["1"], ["2"]],
    ],
    [
      "a cross-listing from another semester",
      [
        ["1", "canvas", "EECS C106A - LEC 001", { term: "Fall 2026" }],
        ["2", "gradescope", "ME C106A", { term: "Spring 2026" }],
      ],
      [["1"], ["2"]],
    ],
    [
      "PHYS 7A and PHYSICS 7A when their titles disagree",
      [
        ["1", "prairielearn", "PHYS 7A: Physics for Scientists and Engineers, Fall 2026"],
        ["2", "prairielearn", "PHYSICS 7A: Ancient Poetry Workshop, Fall 2026"],
      ],
      [["1"], ["2"]],
    ],
    [
      "sites that aren't classes",
      [
        ["1", "canvas", "Golden Bear Orientation 2026"],
        ["2", "canvas", "EECS Advising"],
        ["3", "canvas", "Student Learning Center Workshop 3"],
      ],
      [["1"], ["2"], ["3"]],
    ],
  ];

  for (const [name, copies, expected] of cases) {
    it(name, () => {
      expect(classes(copies)).toEqual(sorted(expected));
    });
  }
});

describe("words that aren't course codes", () => {
  const codes = (name: string) => courseCodes({ platform: "canvas", id: "1", name }).map((c) => c.label);

  it("ignores terms however they're written", () => {
    for (const term of ["Fall 2026", "Fall26", "FA26", "Fall 26", "Fall '26", "SP27", "Summer Session A 2026", "2026 Fall", "Fall Semester 2026"]) {
      expect(codes(`CS 61A ${term}`), term).toEqual(["CS 61A"]);
    }
  });

  it("ignores sections, everyday words and filler", () => {
    for (const name of [
      "CS 61A - LEC 001",
      "CS 61A DIS 101",
      "CS 61A Week 3 Section 101",
      "CS 61A Project 3 Group 12",
      "CS 61A Room 310",
      "CS 61A Part 2",
      "CS 61A HW 3",
      "Intro to CS 61A",
      "Principles of CS 61A",
    ]) {
      expect(codes(name), name).toEqual(["CS 61A"]);
    }
    expect(codes("Data Structures Part 2")).toEqual([]);
    expect(codes("Student Learning Center Workshop 3")).toEqual([]);
  });

  it("reads every common term format", () => {
    const fall26 = { season: "Fall", year: 2026 };
    for (const text of ["Fall 2026", "2026 Fall", "Fall, 2026", "Fall Semester 2026", "Fall Term 2026", "Fall 26", "Fall26", "Fall '26", "FA26", "CS 61C: Great Ideas, Fall 2026"]) {
      expect(parseTerm(text), text).toEqual(fall26);
    }
    expect(parseTerm("Summer Session A 2026")).toEqual({ season: "Summer", year: 2026 });
    expect(parseTerm("Spring Quarter 2027")).toEqual({ season: "Spring", year: 2027 });
    expect(parseTerm("CS 61A - LEC 001")).toBeNull();
  });
});

describe("any combination of code, term, section and filler", () => {
  // Each class, written the ways sites write it. All forms of one class must read as its key.
  const CLASSES: [key: string, forms: string[]][] = [
    ["cs61a", ["COMPSCI 61A", "CS 61A", "CS61A", "cs 61a", "Computer Science 61A"]],
    ["cs61b", ["COMPSCI 61B", "CS 61B", "CS61B"]],
    ["cs160", ["COMPSCI 160", "CS 160", "CS160"]],
    ["cs169a", ["COMPSCI 169A", "CS 169A", "CS169A"]],
    ["cs194-26", ["COMPSCI 194-26", "CS 194-26", "CS194-26"]],
    ["ee16a", ["EL ENG 16A", "EE 16A", "ELENG 16A"]],
    ["eecs106a", ["EECS C106A", "EECS 106A"]],
    ["me106a", ["MEC ENG C106A", "ME 106A", "MECENG 106A"]],
    ["math1a", ["MATH 1A", "Math 1A", "MATHEMATICS 1A"]],
    ["math1b", ["MATH 1B", "Math 1B"]],
    ["mathh54", ["MATH H54", "Math H54"]],
    ["math54", ["MATH 54", "Math 54"]],
    ["chem1a", ["CHEM 1A", "Chem 1A"]],
    ["englishr1a", ["ENGLISH R1A", "English R1A"]],
    ["data100", ["DATA C100", "DATA 100", "Data 100"]],
    ["stat134", ["STAT 134", "STATISTICS 134", "Stats 134"]],
    ["ethstd21ac", ["ETH STD 21AC"]],
    ["integbi35ac", ["INTEGBI 35AC"]],
    ["cs2110", ["CS 2110"]],
  ];
  const TERMS = ["", "Fall 2026", "(Fall 2026)", "Fall26", "(Fall26)", "FA26", "Fall '26", "Fall Semester 2026", "2026 Fall", "SP27", "Summer Session A 2026"];
  const SECTIONS = ["", "- LEC 001", "LEC 001", "- DIS 101", "LAB 012", "SEM 005", "-001"];
  const BEFORE = ["", "Intro to", "Principles of", "Welcome to"];
  const AFTER = ["", ": Some Course Title", "Week 3", "Section 101", "Project 3 Group 12", "Room 310", "Part 2", "Workshop 4"];

  // A small seeded generator, so the same combinations run every time.
  let seed = 7;
  const pick = <T>(list: T[]) => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return list[seed % list.length]!;
  };
  // Terms and extra words can come before or after the code, as sites write them either way.
  const decorate = (form: string) => {
    const parts =
      pick([0, 1]) === 0
        ? [pick(BEFORE), form, pick(SECTIONS), pick(AFTER), pick(TERMS)]
        : [pick(TERMS), pick(AFTER), pick(BEFORE), form, pick(SECTIONS)];
    return parts.filter(Boolean).join(" ").replace(/\s+/g, " ");
  };

  it("reads exactly the right code, and nothing else, from 3,000 decorated names", () => {
    const misses: string[] = [];
    for (let i = 0; i < 3000; i++) {
      const [key, forms] = pick(CLASSES);
      const name = decorate(pick(forms));
      const found = courseCodes({ platform: "canvas", id: "1", name }).map((c) => c.key);
      if (found.join() !== key) misses.push(`${name} -> [${found.join(", ")}] (want ${key})`);
    }
    expect(misses.slice(0, 10)).toEqual([]);
  });

  it("never puts two different classes together, across 1,000 decorated pairs", () => {
    // Pairs that really are one class (cross-listings, short department names) are allowed to join.
    const sameClass = new Set(["eecs106a|me106a"]);
    const wrong: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const [keyA, formsA] = pick(CLASSES);
      const [keyB, formsB] = pick(CLASSES);
      if (keyA === keyB || sameClass.has([keyA, keyB].sort().join("|"))) continue;
      const nameA = decorate(pick(formsA));
      const nameB = decorate(pick(formsB));
      const groups = classes([
        ["A", "canvas", nameA],
        ["B", "gradescope", nameB],
      ]);
      if (groups.length !== 2) wrong.push(`"${nameA}" + "${nameB}"`);
    }
    expect(wrong.slice(0, 10)).toEqual([]);
  });

  it("always puts two writings of the same class together, across 1,000 decorated pairs", () => {
    const apart: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const [, forms] = pick(CLASSES);
      // Same term on both, as sites in one semester would show.
      const term = pick(TERMS.filter(Boolean));
      const nameA = `${pick(BEFORE)} ${pick(forms)} ${pick(SECTIONS)} ${term}`.trim();
      const nameB = `${pick(forms)} ${pick(AFTER)} ${term}`.trim();
      const groups = classes([
        ["A", "canvas", nameA],
        ["B", "gradescope", nameB],
      ]);
      if (groups.length !== 1) apart.push(`"${nameA}" + "${nameB}"`);
    }
    expect(apart.slice(0, 10)).toEqual([]);
  });
});
