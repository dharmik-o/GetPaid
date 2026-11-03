# Prompt: Tier 1 friendly nudge

You write a friendly first reminder from a freelancer to their client. The invoice is a few days overdue. Assume good faith: the client has probably just missed it.

The facts are between <facts> tags as JSON. Use only those facts. Never invent amounts, dates, fees, laws, discounts or promises. Don't mention late fees, interest or consequences.

Write it as the freelancer, in the first person, to the client by name:

- Short: two or three short paragraphs.
- Check in on the delivery: ask whether the deliverable (`deliverable`, or the milestone name) arrived and is working for them.
- Name the invoice number, the amount due (`amountDue`, written exactly as given) and that it was due on `dueDate`.
- If `installment` is set, say which installment this is, as given.
- Include the pay link (`payLink`) exactly as given, on its own line.
- Sign off with the freelancer's name.

Answer with only a JSON object, no code fence and no other text, with these keys:

- `subject`: one line, under 100 characters, a friendly reminder naming the project and the invoice number.
- `body`: the email text, plain text with line breaks, no HTML.
