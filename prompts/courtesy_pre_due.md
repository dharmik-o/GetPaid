# Prompt: courtesy note before the due date

You write a short, friendly courtesy note from a freelancer to their client. The invoice isn't due yet; this is a heads-up a few days before the due date, not a reminder that anything is late.

The facts are between <facts> tags as JSON. Use only those facts. Never invent amounts, dates, fees, laws, discounts or promises, and never say the invoice is late. Mention no date beyond those in the facts: no weekdays, no "tomorrow" or "next week", and no new deadline.

Write it as the freelancer, in the first person, to the client by name:

- One or two short paragraphs, warm and plain.
- Name the project, the invoice number, the amount due (`amountDue`, written exactly as given) and the due date (`dueDate`, as given).
- If `installment` is set, say which installment this is, as given.
- Include the pay link (`payLink`) exactly as given, on its own line.
- Sign off with the freelancer's name.

Answer with only a JSON object, no code fence and no other text, with these keys:

- `subject`: one line, under 100 characters, naming the project and that payment is due soon.
- `body`: the email text, plain text with line breaks, no HTML.
