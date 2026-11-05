import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  archiveDirProblem,
  archiveRelativePath,
  defaultArchiveDir,
  resolveInsideArchive,
  safeSegment,
} from "@/lib/archive-paths";

// A client or project name is free text, and becomes a folder on the freelancer's disk.

const ROOT = resolve(tmpdir(), "getpaid-archive-root");

describe("a name as a folder", () => {
  it("keeps an ordinary name as it is", () => {
    expect(safeSegment("Hudson Street Bakery")).toBe("Hudson Street Bakery");
    expect(safeSegment("Café Müller & Söhne")).toBe("Café Müller & Söhne");
  });

  it.each([
    ["../../etc/passwd", "etc passwd"],
    ["..\\..\\Windows\\System32", "Windows System32"],
    ["/etc/passwd", "etc passwd"],
    ["C:\\Users\\Admin", "C Users Admin"],
    ["..", "Unnamed"],
    [".", "Unnamed"],
    ["...", "Unnamed"],
    ["../..", "Unnamed"],
    ["", "Unnamed"],
    ["   ", "Unnamed"],
    ["???", "Unnamed"],
  ])("makes %j safe", (name, expected) => {
    expect(safeSegment(name)).toBe(expected);
  });

  it.each([
    ['Acme: "the best" <Ltd>|?*', "Acme the best Ltd"],
    ["line\nbreak\ttab", "line break tab"],
    ["trailing dots...", "trailing dots"],
    ["trailing space ", "trailing space"],
    [".hidden", "hidden"],
    ["zero\u200Bwidth", "zero width"],
    ["right\u202Eleft", "right left"],
    ["nul\0byte", "nul byte"],
  ])("removes what Windows or macOS refuse from %j", (name, expected) => {
    expect(safeSegment(name)).toBe(expected);
  });

  it.each([
    "CON",
    "con",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "com9",
    "LPT1",
    "lpt9",
    "CON.txt",
    "nul.pdf",
  ])("doesn't use Windows' reserved name %s", (name) => {
    expect(safeSegment(name)).toBe(`_${name}`);
  });

  it("leaves names that only start like a reserved one", () => {
    expect(safeSegment("Console Co")).toBe("Console Co");
    expect(safeSegment("Auxiliary")).toBe("Auxiliary");
  });

  it("caps the length", () => {
    expect(Array.from(safeSegment("x".repeat(500)))).toHaveLength(60);
  });

  it("doesn't cut a character in half at the cap", () => {
    const capped = safeSegment("😀".repeat(100));
    expect(Array.from(capped)).toHaveLength(60);
    expect(capped).toBe("😀".repeat(60));
  });

  it("doesn't end in a dot or space after being capped", () => {
    const capped = safeSegment(`${"x".repeat(59)}. tail`);
    expect(capped).toBe("x".repeat(59));
  });

  it("is one normal form, so the same name is the same folder on macOS and Windows", () => {
    expect(safeSegment("Cafe\u0301")).toBe("Caf\u00e9");
  });
});

describe("a file's path in the archive", () => {
  const facts = {
    clientName: "Hudson Street Bakery",
    projectTitle: "Website redesign",
    invoiceNumber: "FPR-000042",
  };

  it("is client, project and invoice number", () => {
    expect(archiveRelativePath({ ...facts, version: 1 })).toBe(
      "Hudson Street Bakery/Website redesign/FPR-000042.pdf",
    );
  });

  it("names later versions", () => {
    expect(archiveRelativePath({ ...facts, version: 2 })).toBe(
      "Hudson Street Bakery/Website redesign/FPR-000042 (v2).pdf",
    );
  });

  it("gives a retainer with no project a folder of its own", () => {
    expect(archiveRelativePath({ ...facts, projectTitle: null, version: 1 })).toBe(
      "Hudson Street Bakery/Retainers/FPR-000042.pdf",
    );
  });

  it("stays inside the archive, whatever the names are", () => {
    for (const hostile of ["../../..", "..\\..\\..", "/etc", "C:\\", "CON", "\0", ".."]) {
      const path = archiveRelativePath({
        clientName: hostile,
        projectTitle: hostile,
        invoiceNumber: hostile,
        version: 1,
      });
      expect(resolveInsideArchive(ROOT, path), path).toBeDefined();
      expect(path.split("/")).toHaveLength(3);
      expect(path).not.toContain("..");
    }
  });
});

describe("reading from the archive", () => {
  it("finds a file inside it", () => {
    expect(resolveInsideArchive(ROOT, "Client/Project/FPR-1.pdf")).toBe(
      join(ROOT, "Client", "Project", "FPR-1.pdf"),
    );
  });

  it.each([
    "../secret.pdf",
    "../../secret.pdf",
    "Client/../../secret.pdf",
    "..\\secret.pdf",
    "Client\\..\\..\\secret.pdf",
    "/etc/secret.pdf",
    "C:\\Windows\\secret.pdf",
    "C:secret.pdf",
    "\\\\server\\share\\secret.pdf",
    "Client/secret.pdf\0.png",
    "Client/passwords.txt",
    ".env",
    "",
    ".",
  ])("refuses %j", (path) => {
    expect(resolveInsideArchive(ROOT, path)).toBeUndefined();
  });

  it("refuses a sibling folder that only starts with the archive's name", () => {
    expect(resolveInsideArchive(ROOT, "../getpaid-archive-root-other/x.pdf")).toBeUndefined();
  });
});

describe("the archive folder", () => {
  it("is INVOICE_ARCHIVE_DIR when it's set", () => {
    expect(defaultArchiveDir({ INVOICE_ARCHIVE_DIR: ROOT })).toBe(ROOT);
  });

  it("is <Documents>/GetPaid/Invoices when it isn't", () => {
    expect(defaultArchiveDir({}, homedir())).toBe(
      join(homedir(), "Documents", "GetPaid", "Invoices"),
    );
  });

  it("treats a blank setting as not set", () => {
    expect(defaultArchiveDir({ INVOICE_ARCHIVE_DIR: "  " }, homedir())).toBe(
      join(homedir(), "Documents", "GetPaid", "Invoices"),
    );
  });

  it("is fine outside a git repository", () => {
    expect(archiveDirProblem(ROOT)).toBeUndefined();
  });

  it("is refused inside this repository, where it could be committed", () => {
    expect(archiveDirProblem(join(process.cwd(), "invoices"))).toContain("git repository");
    expect(archiveDirProblem(join(process.cwd(), "docs", "archive"))).toContain("git repository");
  });

  it("is allowed inside the repository only in a folder git ignores", () => {
    expect(archiveDirProblem(join(process.cwd(), "invoice-archive"))).toBeUndefined();
    expect(archiveDirProblem(join(process.cwd(), ".data", "archive"))).toBeUndefined();
  });
});
