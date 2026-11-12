import { expect, test } from "@playwright/test";
import pg from "pg";
import { DEMO_USER_ID } from "../../apps/web/src/lib/auth";
import { DATABASE_URL } from "./env";

// E2 in a real browser: archive a project, see it vanish, restore it, then delete it by typing its
// name. Its own project, so no other spec sees it; named to run last.

const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const PROJECT = "e2000000-0000-4000-8000-0000000000a1";
const TITLE = "Throwaway brochure site";

const query = async <T extends object>(sql: string, params: unknown[] = []): Promise<T[]> => {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
};

test("archive, hide, restore, then delete a project by typing its name", async ({ page }) => {
  await query("DELETE FROM public.projects WHERE id = $1", [PROJECT]);
  await query(
    `INSERT INTO public.projects (id, user_id, client_id, title, total_cents, currency, deadline)
     VALUES ($1, $2, $3, $4, 40000, 'USD', '2026-12-31')`,
    [PROJECT, DEMO_USER_ID, CLIENT, TITLE],
  );
  try {
    await page.goto("/projects", { waitUntil: "networkidle" });
    await expect(page.getByRole("link", { name: TITLE })).toBeVisible();

    await page.goto(`/projects/${PROJECT}`, { waitUntil: "networkidle" });
    const danger = page.getByRole("region", { name: "Danger zone" });
    await danger.getByRole("button", { name: "Archive project" }).click();
    await expect(page.getByRole("heading", { name: TITLE }).getByText("Archived")).toBeVisible();

    await page.goto("/projects", { waitUntil: "networkidle" });
    await expect(page.getByRole("link", { name: TITLE })).toHaveCount(0);
    await page.getByRole("link", { name: "Show archived" }).click();
    await expect(page.getByRole("link", { name: TITLE })).toBeVisible();
    await expect(page.getByText("Archived", { exact: true })).toBeVisible();

    await page.getByRole("link", { name: TITLE }).click();
    await page
      .getByRole("region", { name: "Danger zone" })
      .getByRole("button", { name: "Restore project" })
      .click();
    await expect(page.getByRole("heading", { name: TITLE }).getByText("Archived")).toHaveCount(0);
    await page.goto("/projects", { waitUntil: "networkidle" });
    await expect(page.getByRole("link", { name: TITLE })).toBeVisible();

    await page.goto(`/projects/${PROJECT}`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Delete project" }).click();
    const confirm = page.getByRole("group", { name: "Delete this project" });
    await expect(page.getByRole("region", { name: "Danger zone" })).toContainText(
      "Invoice PDFs already saved in your archive folder stay",
    );
    const button = confirm.getByRole("button", { name: "Delete this project for good" });
    await expect(button).toBeDisabled();
    await confirm.getByLabel(/Type the project name/).fill("Throwaway");
    await expect(button).toBeDisabled();
    await confirm.getByLabel(/Type the project name/).fill(TITLE);
    await expect(button).toBeEnabled();
    await button.click();

    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole("link", { name: TITLE })).toHaveCount(0);
    const rows = await query<{ n: string }>(
      "SELECT count(*)::text AS n FROM public.projects WHERE id = $1",
      [PROJECT],
    );
    expect(rows[0]?.n).toBe("0");
  } finally {
    await query("DELETE FROM public.projects WHERE id = $1", [PROJECT]);
  }
});
