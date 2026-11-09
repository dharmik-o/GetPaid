import { parseStatuteTable } from "./legal";
import { parseReferenceRates } from "./reference-rates";
import { REFERENCE_RATE_TABLE } from "./reference-rate-table";
import { STATUTE_TABLE } from "./statute-table";

// The checked law table (legal/statutes.json) and the reference rates (legal/reference-rates.json).
// Both throw at start-up if an entry is malformed.
export const STATUTES = parseStatuteTable(STATUTE_TABLE);
export const REFERENCE_RATES = parseReferenceRates(REFERENCE_RATE_TABLE);
