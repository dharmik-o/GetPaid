# M11 summary: invoice themes, signatures, archive and history

Everything in M11 is built, with `npm run check` and `npm run test:e2e` green. To use it, run the two commands under "What you need to do". It hasn't run against your real Gmail, PayPal or database yet.

## What was built

| Feature       | What you get                                                                                                                                                                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Themes**    | Studio, Ledger and Noir, with Classic and Minimal restyled and Modern kept as it was. All six have Pay online with an optional QR code, a signature block and embedded fonts, and no bank fields. Settings has a gallery with a thumbnail of each. |
| **Signature** | Upload a PNG or JPG, or type a name that's drawn in a handwriting font, plus the signer's name and title and a default. "Include my signature" appears wherever an invoice is created, and is stored on the invoice.                               |
| **Archive**   | Every PDF sent to a client is saved as `<Client>/<Project>/FPR-000042.pdf`. A changed document becomes `FPR-000042 (v2).pdf`, and nothing is overwritten or deleted. Settings shows the folder, with a Copy button.                                |
| **History**   | An Invoices section on the Project page and an Invoices tab on the Client page, with filters, downloads, and totals per currency that are never converted.                                                                                         |

## Done-when checks

| Check                                                                                      | Result | Where                                                                                                           |
| ------------------------------------------------------------------------------------------ | ------ | --------------------------------------------------------------------------------------------------------------- |
| Every built-in renders every tag, fits one page in A4 and Letter, and passes the sanitiser | Pass   | `tests/invoice-themes.test.ts`: real Chromium PDFs, counting pages, with 12 line items and with 12 installments |
| Signature on or off is respected per invoice                                               | Pass   | `tests/api/invoice-signature.test.ts`, `reply-split`, `maintenance`                                             |
| A sent PDF is at the expected path with a matching sha256                                  | Pass   | `tests/api/invoice-archive.test.ts`, through the real sender                                                    |
| A changed PDF becomes v2 without touching v1                                               | Pass   | Same file: compares v1's bytes and modified time                                                                |
| Path tests cover unsafe names and traversal                                                | Pass   | `tests/archive-paths.test.ts`                                                                                   |
| The Project and Client pages list the right invoices for the right user only               | Pass   | `tests/api/invoice-history.test.ts`, on real RLS                                                                |
| The Playwright demo passes, and the Project page shows its invoices                        | Pass   | `npm run test:e2e`: 112 of 112                                                                                  |

Also run: `npm run check` (2,335 tests pass, 1 skipped), RLS on real Docker Postgres (90 of 90), and a production build, which succeeds.

## What hasn't been checked

- **Your real data and accounts.** Tests use a fake Gmail and PayPal. The archive has only been written to temporary folders, never your real `Documents` folder.
- **Scanning a QR code.** Tests check that the code is made locally and is the same each time, but nothing decodes it, as that would need another dependency. **Please scan one with your phone.**
- **Printing.** I checked the themes on screen at A4 size, and page counts from real PDFs in both sizes. I haven't looked at Letter, or at Classic, Modern and Minimal with 12 items, by eye.
- **One test is skipped on Windows:** a link inside the archive that leads outside it, as Windows only lets an administrator make one. The code check is there, but it's only been exercised on the path-based cases.

## What you need to do

1. **`npm run db:migrate`**, which adds 3 migrations (024 to 026).
2. **`npm run invoices:archive-existing`**, once, which moves PDFs from `.data/invoice-pdfs` into the archive. It's safe to run again. Each moved invoice's next reminder makes a v2, because old PDFs have no record of the document they came from.
3. **Back up the archive folder.** It holds client data. If `Documents` syncs to OneDrive or similar, decide whether you want client invoices there.
4. Restart `npm run dev`, as there are new packages.

These are also in `docs/NEEDS_YOU.md`.

## Decisions worth checking

All are logged in `docs/DECISIONS.md`.

- **A reminder is held if its PDF can't be saved.** You asked that every sent PDF is in the archive, so it's saved before Gmail is called. A broken folder pauses reminders, and the Outbox says why.
- **Reminders now carry the current document.** A PDF used to be made once and reused. Now a change of logo, template or signature reaches the client's next reminder, and is kept as a new version. A paid installment also changes the schedule on the next one's document.
- **"Changed" means the document, not the bytes.** Chromium stamps each PDF with the time, so comparing bytes would make a new version on every send.
- **The existing Invoices section on the Project page is now "Bill your milestones",** so the history could have the name you asked for.
- **Paper size and the QR code are account settings,** A4 and on by default. You asked for both sizes to fit, so something had to choose.
- **Tax and discount always show,** as `USD 0.00` when zero, as in your references.
- **Deleting a client leaves its PDFs on disk.** The app never deletes them, and the delete screen now says so.
- **The redesign's section in `docs/FEATURES.md` was also called M11,** so it's now just "Redesign and landing page". The landing page is still its one unticked item.

## Known small issues

- `next build` warns about dynamic file access on `defaultPdfDir`. That line was already there, and I left it as unrelated.
- A signature's handwriting font covers Latin and accented Latin. A name in another script would fall back to a plain system font, so upload an image for those.
- Studio's rotated strips sit at fixed positions on the page, so a very long client address could reach the Pay online strip.

## New dependencies

`@fontsource/ibm-plex-mono`, `ibm-plex-sans`, `ibm-plex-serif`, `mrs-saint-delafield` (all OFL) and `qrcode-generator` (MIT, no dependencies of its own). None has an install script, and `npm audit` finds nothing in production.
