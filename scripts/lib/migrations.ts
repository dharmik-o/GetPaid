const MIGRATION_FILE = /^(\d+)_[\w-]+\.sql$/;

interface NumberedFile {
  name: string;
  number: number;
}

const toNumbered = (name: string): NumberedFile[] => {
  const prefix = MIGRATION_FILE.exec(name)?.[1];
  return prefix === undefined ? [] : [{ name, number: Number(prefix) }];
};

const assertUniqueNumbers = (files: readonly NumberedFile[]): void => {
  const seen = new Map<number, string>();
  for (const file of files) {
    const previous = seen.get(file.number);
    if (previous !== undefined) {
      const number = String(file.number).padStart(3, "0");
      throw new Error(
        `Two migrations share the number ${number}: ${previous} and ${file.name}. Renumber one of them.`,
      );
    }
    seen.set(file.number, file.name);
  }
};

/** Keeps only `NNN_name.sql` files and returns them in numeric order. */
export const orderMigrations = (fileNames: readonly string[]): string[] => {
  const numbered = fileNames.flatMap(toNumbered);
  assertUniqueNumbers(numbered);
  return numbered.sort((a, b) => a.number - b.number).map((file) => file.name);
};

/** Migrations not yet recorded in `schema_migrations`, in order. */
export const pendingMigrations = (
  ordered: readonly string[],
  applied: ReadonlySet<string>,
): string[] => ordered.filter((name) => !applied.has(name));
