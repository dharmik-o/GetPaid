import { openMigratedPglite } from "./pglite";
import { defineRlsIsolationSuite } from "./rls-isolation.suite";

defineRlsIsolationSuite("PGlite", openMigratedPglite);
