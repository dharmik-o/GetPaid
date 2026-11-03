import { currentUserId } from "./auth";
import { withUserDb, type UserDbRunner } from "./db";

/** Runs database work as the freelancer making this request (RLS applies). Server-only. */
export const runAsCurrentUser: UserDbRunner = (work) => withUserDb(currentUserId())(work);
