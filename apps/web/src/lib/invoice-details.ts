import { z } from "zod";
import type { Db } from "./db";
import { toFieldIssues, type FieldIssue } from "./field-issues";
import { getTemplate } from "./invoice-templates";
import { SIGNATURE_MAX_CHARS, signatureImageProblem } from "./signature-rules";

// Server-only: what the invoice document shows about the freelancer and each client, and their
// default templates. Read and written as the signed-in user (RLS).

/** The logo is stored as an embedded image, so a PDF never loads it from the network. */
export const LOGO_DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
export const LOGO_MAX_CHARS = 300_000;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `must be ${String(max)} characters or fewer`)
    .nullable()
    .transform((value) => (value ? value : null));

const templateId = z.uuid({ error: "must be picked from the list" }).nullable();

/** Checked before the content, so an enormous upload is refused without being examined. */
const signatureImage = z
  .string({ error: "must be a PNG or JPG image" })
  .max(SIGNATURE_MAX_CHARS, "is too large: use an image under 500 KB")
  .superRefine((value, context) => {
    const problem = signatureImageProblem(value);
    if (problem) context.addIssue({ code: "custom", message: problem });
  })
  .nullable();

export const freelancerDetailsSchema = z.strictObject({
  businessName: optionalText(120),
  address: optionalText(500),
  logoDataUrl: z
    .string()
    .max(LOGO_MAX_CHARS, "is too large: use an image under 200 KB")
    .regex(LOGO_DATA_URL, "must be a PNG, JPEG, GIF or WebP image")
    .nullable(),
  defaultTemplateId: templateId,
  invoicePaper: z.enum(["A4", "Letter"], { error: "must be A4 or Letter" }),
  invoiceShowQr: z.boolean({ error: "must be on or off" }),
  signatureSource: z.enum(["upload", "typed"], { error: "must be upload or typed" }).nullable(),
  signatureImageDataUrl: signatureImage,
  signatureTypedName: optionalText(120),
  signatureName: optionalText(120),
  signatureTitle: optionalText(120),
  signatureDefault: z.boolean({ error: "must be on or off" }),
});

export const clientDetailsSchema = z.strictObject({
  company: optionalText(120),
  address: optionalText(500),
  defaultTemplateId: templateId,
});

export type FreelancerDetails = z.infer<typeof freelancerDetailsSchema> & {
  name: string;
  email: string;
};
export type ClientDetails = z.infer<typeof clientDetailsSchema>;

type Saved<T> = { ok: true; value: T } | { ok: false; errors: FieldIssue[] };

/** A default must be a template this user can see: a built-in or their own. */
const templateIssues = async (db: Db, id: string | null): Promise<FieldIssue[]> =>
  id === null || (await getTemplate(db, id))
    ? []
    : [{ field: "defaultTemplateId", message: "must be picked from the list" }];

export const getFreelancerDetails = async (db: Db): Promise<FreelancerDetails | undefined> => {
  const { rows } = await db.query<{
    name: string;
    email: string;
    business_name: string | null;
    address: string | null;
    logo_data_url: string | null;
    default_template_id: string | null;
    invoice_paper: "A4" | "Letter";
    invoice_show_qr: boolean;
    signature_source: "upload" | "typed" | null;
    signature_image_data_url: string | null;
    signature_typed_name: string | null;
    signature_name: string | null;
    signature_title: string | null;
    signature_default: boolean;
  }>(
    `SELECT name, email, business_name, address, logo_data_url, default_template_id::text,
       invoice_paper, invoice_show_qr, signature_source, signature_image_data_url,
       signature_typed_name, signature_name, signature_title, signature_default
     FROM public.users WHERE id = (SELECT auth.uid())`,
  );
  const row = rows[0];
  return row
    ? {
        name: row.name,
        email: row.email,
        businessName: row.business_name,
        address: row.address,
        logoDataUrl: row.logo_data_url,
        defaultTemplateId: row.default_template_id,
        invoicePaper: row.invoice_paper,
        invoiceShowQr: row.invoice_show_qr,
        signatureSource: row.signature_source,
        signatureImageDataUrl: row.signature_image_data_url,
        signatureTypedName: row.signature_typed_name,
        signatureName: row.signature_name,
        signatureTitle: row.signature_title,
        signatureDefault: row.signature_default,
      }
    : undefined;
};

/** What "Include my signature" starts from, wherever an invoice is created. */
export const signatureChoiceFrom = (
  details: FreelancerDetails | undefined,
): { available: boolean; byDefault: boolean } => ({
  available: Boolean(details?.signatureImageDataUrl),
  byDefault: details?.signatureDefault ?? false,
});

/** The signature fields as they must be saved together, or why they can't be. */
const signatureFields = (input: FreelancerDetails): FieldIssue[] => {
  if (input.signatureSource === "upload" && !input.signatureImageDataUrl) {
    return [{ field: "signatureImageDataUrl", message: "is required: choose a PNG or JPG image" }];
  }
  if (input.signatureSource === "typed" && !input.signatureTypedName) {
    return [{ field: "signatureTypedName", message: "is required: type the name to draw" }];
  }
  return [];
};

export const saveFreelancerDetails = async (
  db: Db,
  raw: unknown,
): Promise<Saved<FreelancerDetails>> => {
  // Partial: a field left out keeps its saved value (the default and the details are saved
  // from different parts of the screen).
  const parsed = freelancerDetailsSchema.partial().safeParse(raw);
  if (!parsed.success) return { ok: false, errors: toFieldIssues(parsed.error, { noun: "field" }) };
  const current = await getFreelancerDetails(db);
  if (!current) throw new Error("Your account wasn't found. Sign in again.");
  const input = { ...current, ...parsed.data };
  const errors = [
    ...(await templateIssues(db, input.defaultTemplateId)),
    ...signatureFields(input),
  ];
  if (errors.length > 0) return { ok: false, errors };
  const hasSignature = input.signatureSource !== null;
  await db.query(
    `UPDATE public.users SET business_name = $1, address = $2, logo_data_url = $3,
       default_template_id = $4, invoice_paper = $5, invoice_show_qr = $6,
       signature_source = $7, signature_image_data_url = $8, signature_typed_name = $9,
       signature_name = $10, signature_title = $11, signature_default = $12
     WHERE id = (SELECT auth.uid())`,
    [
      input.businessName,
      input.address,
      input.logoDataUrl,
      input.defaultTemplateId,
      input.invoicePaper,
      input.invoiceShowQr,
      input.signatureSource,
      hasSignature ? input.signatureImageDataUrl : null,
      input.signatureSource === "typed" ? input.signatureTypedName : null,
      hasSignature ? input.signatureName : null,
      hasSignature ? input.signatureTitle : null,
      input.signatureDefault,
    ],
  );
  const saved = await getFreelancerDetails(db);
  if (!saved) throw new Error("Your details could not be read back after saving.");
  return { ok: true, value: saved };
};

export const getClientDetails = async (
  db: Db,
  clientId: string,
): Promise<ClientDetails | undefined> => {
  const { rows } = await db.query<{
    company: string | null;
    address: string | null;
    default_template_id: string | null;
  }>("SELECT company, address, default_template_id::text FROM public.clients WHERE id = $1", [
    clientId,
  ]);
  const row = rows[0];
  return row
    ? { company: row.company, address: row.address, defaultTemplateId: row.default_template_id }
    : undefined;
};

export const saveClientDetails = async (
  db: Db,
  clientId: string,
  raw: unknown,
): Promise<Saved<ClientDetails> | undefined> => {
  if (!(await getClientDetails(db, clientId))) return undefined;
  const parsed = clientDetailsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: toFieldIssues(parsed.error, { noun: "field" }) };
  const input = parsed.data;
  const errors = await templateIssues(db, input.defaultTemplateId);
  if (errors.length > 0) return { ok: false, errors };
  await db.query(
    "UPDATE public.clients SET company = $2, address = $3, default_template_id = $4 WHERE id = $1",
    [clientId, input.company, input.address, input.defaultTemplateId],
  );
  return { ok: true, value: input };
};
