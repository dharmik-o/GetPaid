# Devpost submission

Paste each section into the matching Devpost field.

**Project name:** GetPaid

**Tagline:** You did the work. Now get paid for it. AI-drafted payment reminders you approve from your phone, with a PayPal pay link in every one.

**Built with:** next.js, react, typescript, postgresql, n8n, paypal, claude, ollama, litellm, gmail-api, telegram-bot-api, docker, playwright

## Inspiration

Doing the work is often the easy part of freelancing. The hard part comes afterwards, when an invoice goes quiet and you have to chase a client without damaging the relationship. It's harder across borders, where the client is in another time zone, a firm reminder at the wrong moment can feel rude, and there's no easy way to see where the money has got to.

Most invoicing tools stop at sending the invoice and a generic reminder. We wanted something that protects a freelancer before the work starts, then handles the awkward follow-up after a deadline passes. It should write the emails a careful freelancer would write, and read the replies, while the freelancer stays in charge of every decision about money.

## What it does

GetPaid works in two stages.

**Before the work:** a freelancer sets up a project as deposits, milestones or installments, or as a milestone hold, where PayPal authorizes the money up front and captures it on acceptance. Repeat work can run as a retainer with auto-pay, and maintenance reminders tell the freelancer when a job or renewal is coming up.

**After a deadline:** an hourly scheduler plans each unpaid invoice's next reminder, using the freelancer's own rules for terms, intervals, tiers and send windows in the client's time zone. The AI drafts the email in the right tone, from a courtesy note to a final notice. The draft appears in the dashboard Outbox and as a Telegram card, where the freelancer can approve or skip it, or reply in plain words like "mention the 15th" to get a redraft. It then goes out from the freelancer's own Gmail, on the original thread, with the same PayPal pay link every time.

When a client writes back, the reminders pause. If they ask "Can I pay half now and half on the 15th?", the AI sorts that as an installment request and suggests a split. With one approval, the open invoice is replaced by two separate PayPal invoices, each with its own due date and its own reminders. When PayPal confirms a payment through a verified webhook, the reminders stop by themselves.

Approval is required by default. A freelancer can choose to auto-send the first friendly tier, but a final notice always needs a human. The AI can't change an invoice, an amount or a schedule, whatever a client's email says.

The freelancer also gets branded invoice PDFs from six themes or their own HTML, a local archive of every PDF sent, an evidence timeline per client, and metrics for the amount recovered and days late.

## How we built it

- **Dashboard:** Next.js 16 and TypeScript in strict mode, on Postgres with row-level security on every table holding user data. Money is stored as integer cents, and schedules are worked out in one module with Luxon, tested across weekends, daylight saving changes and clients 12 or more hours ahead.
- **Automation:** seven n8n workflows, stored as JSON in the repo: scheduler, drafter, approval handler, sender, reply listener, PayPal webhook and AI router. They trigger and relay, and the decisions live in tested TypeScript in the app.
- **Documents:** invoice PDFs come from Mustache templates, through a sanitiser, into headless Chromium with JavaScript and network access off, because custom HTML is untrusted input.
- **Tests:** PayPal, Gmail, Telegram and the models are mocked with msw, and database tests run the real migrations and row-level security on PGlite and Docker Postgres. A Playwright test runs the full 8-step demo in a real browser.
- **Claude Code:** the project was built with Claude Code, working from a written spec, a build order with "done when" checks, and hooks that keep it away from secrets.

### PayPal APIs

Everything runs against the PayPal sandbox.

| API                                          | Calls                                                                                                                                  | How it's used                                                                                                                                                                      |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Invoicing v2**                             | `POST /v2/invoicing/invoices`, `/send`, `/cancel`, `POST /v2/invoicing/search-invoices`                                                | One invoice per milestone, installment or retainer cycle, with its link reused in every reminder. Search finds an existing invoice by number, so a retry can't create a duplicate. |
| **Orders v2**                                | `POST /v2/checkout/orders`, `/authorize`                                                                                               | A milestone hold: the client approves, and the money is authorized before work starts.                                                                                             |
| **Payments v2**                              | `/v2/payments/authorizations/{id}/capture`, `/reauthorize`, `/void`; `GET /v2/payments/captures/{id}`, `GET /v2/payments/refunds/{id}` | Capture on acceptance, reauthorize after PayPal's 3-day honor period, void on cancel, and read capture and refund state to reconcile webhook events.                               |
| **Catalog Products v1 and Subscriptions v1** | `POST /v1/catalogs/products`, `POST /v1/billing/plans`, `POST /v1/billing/subscriptions`, `/suspend`, `/activate`                      | Retainers with auto-pay. After a failed charge, the subscription is suspended and a catch-up invoice takes over with the normal reminders.                                         |
| **Webhooks**                                 | `POST /v1/notifications/verify-webhook-signature`                                                                                      | Every event is verified before anything changes. An event only says which record to look at; its state is read from PayPal.                                                        |

We deliberately don't use PayPal's partial payments, because they aren't offered in every country. Installments are separate invoices with fixed amounts, which work everywhere.

### AI models

Every model is reached through one OpenAI-compatible chat call, so changing models means changing a base URL, a key and a model name. The freelancer picks a model in Settings, and can choose a different one for each of three tasks.

| Task       | What the AI does                                                                                                                                    | Model                                                                                  |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **Sort**   | Labels a client reply: promise to pay, installment request, paid elsewhere, dispute, out of office, or unclear                                      | A small or local model is enough, such as `llama3.2` on Ollama or Claude Haiku         |
| **Draft**  | Writes reminders for each tier, maintenance heads-ups and approval emails, redrafts from plain-word feedback, and writes the text parts of invoices | Claude Sonnet (`claude-sonnet-5-5` is the preset) or any model the freelancer connects |
| **Tier 3** | Writes the final notice                                                                                                                             | The strongest model the freelancer has set                                             |

Presets cover Claude, OpenAI, Gemini, Groq, OpenRouter, Ollama and LM Studio, and a custom URL reaches anything else, including a LiteLLM gateway for providers without a compatible endpoint. With a local model, client emails never leave the freelancer's machine.

The AI is kept on a short leash:

- Every answer must match a JSON schema. A bad answer is retried once, then replaced by a fixed template, and a draft that fails is never sent.
- Amounts, dates, names and pay links come from the database. A draft that adds a date, amount or link that isn't in its facts is refused.
- A final notice can cite only the contract's own late-fee clause or an entry in a verified table of laws, which is empty until its wording has been reviewed. With neither, it's simply a final notice, with a "not legal advice" note for the freelancer.

## Challenges we ran into

- **PayPal partial payments were refused for our sandbox account's country.** We'd built on them first. We reworked the product around installments as separate invoices, and that turned out better: each one has its own due date, reminders and paid status, and it works in every market.
- **Invoicing v2 ignores `PayPal-Request-Id`.** A retry could have created a second invoice for the same work. Each invoice now also gets a unique number, which PayPal refuses to repeat, and a retry finds and reuses the existing one.
- **Failed subscription charges overlap with PayPal's own retries.** Sending a catch-up invoice while a retry is running could charge a client twice. So the app suspends the subscription first and creates the invoice only once PayPal confirms it. If a charge already under way still collects the money, the invoice is cancelled, or the freelancer is told to check for a double payment.
- **A hold order starts at `PAYER_ACTION_REQUIRED`,** which our code first took for approved. A live run with a sandbox buyer caught it, and mocks wouldn't have.
- **Two approval screens had to agree.** A draft approved on Telegram must disappear from the Outbox, and an old Telegram card must stop working once its wording changes. Both places now go through one set of checks in the app.
- **Letting AI near money.** Small local models are often wrong: `llama3.2` got 13 to 14 of 16 sample replies right in our runs. So we designed for wrong answers. A reply's label only suggests an action, and any reply simply pauses reminders until the freelancer decides.
- **Chromium stamps every PDF with the time,** so comparing files made every send look like a new version. The archive now compares the document the PDF was made from.

## Accomplishments that we're proud of

- The full loop runs from deposit to overdue reminder, approval, reply, split and payment, with a Playwright test covering all 8 steps.
- Live sandbox runs of invoices and of hold capture and void with a real sandbox buyer, plus a real email, a real reply read from its thread, and a real Telegram approval.
- The same flow works with a cloud model, a model on your own laptop, or no model at all, because of the template fallback.
- A client's email can't change an invoice, however it's worded.

## What we learned

Real sandbox runs find what mocks can't. The most useful bugs came from PayPal's actual answers, and what the sandbox refuses is worth knowing early. We also learned that the safest place for AI in a payments product is as a drafter and adviser, with hard rules around money, dates and legal claims.

## What's next for GetPaid

- **Real accounts:** sign-in, and PayPal partner onboarding so each freelancer connects their own PayPal account. Today it's one sandbox account, run locally.
- **Verified laws for final notices:** adding reviewed entries for the UK, EU, India and New York City.
- **Privacy:** optional removal of names and emails before any cloud model call.
- **More markets:** partner rails for countries where PayPal doesn't support receiving money.
- **More approval channels and fewer manual steps:** WhatsApp approvals, importing invoices from email, and public holiday calendars per country.
- **Dispute evidence:** exporting a client's timeline as a PDF pack.
- **Client view:** a simple portal where clients can see their milestones.
