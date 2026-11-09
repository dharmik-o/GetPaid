import { parseStatuteTable } from "../apps/web/src/lib/legal";
import { parseReferenceRates, RATE_BASES } from "../apps/web/src/lib/reference-rates";
import { readRatesFile, readStatuteFile } from "./lib/prompt-source";

// Validates legal/statutes.json and legal/reference-rates.json and lists what the owner still has
// to approve. Exits 1 if either file is malformed.

const out = (line: string): void => {
  process.stdout.write(`${line}\n`);
};

const status = (approved: boolean): string => (approved ? "approved  " : "UNAPPROVED");

try {
  const laws = parseStatuteTable(readStatuteFile());
  out(`Laws (legal/statutes.json): ${String(laws.length)}`);
  for (const law of laws)
    out(`  ${status(law.approved)} ${law.id}  ${law.sourceUrl}  checked ${law.checkedOn}`);
  const rates = parseReferenceRates(readRatesFile());
  out("Reference rates (legal/reference-rates.json):");
  for (const basis of RATE_BASES) {
    out(`  ${basis}: ${String(rates[basis].length)} entries`);
    for (const r of rates[basis])
      out(`    ${status(r.approved)} from ${r.from}  ${String(r.bp)} bp  ${r.source}`);
  }
  const waiting =
    laws.filter((l) => !l.approved).length +
    RATE_BASES.reduce((n, b) => n + rates[b].filter((r) => !r.approved).length, 0);
  out(`${String(waiting)} entries wait for the owner. Nothing unapproved is ever cited or used.`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
