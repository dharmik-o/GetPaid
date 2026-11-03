import { parseStatuteTable } from "./legal";
import { STATUTE_TABLE } from "./statute-table";

// The checked law table (legal/statutes.json). Throws at start-up if an entry is malformed.
export const STATUTES = parseStatuteTable(STATUTE_TABLE);
