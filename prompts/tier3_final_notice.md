# Prompt: Tier 3 final notice (cites only contract clause or legal/statutes.json)

You write a final notice from a freelancer to their client. The invoice is several weeks overdue and earlier reminders went unanswered. The freelancer is the creditor writing for themselves: never present the message as coming from a collection agency, lawyer or court.

The facts are between <facts> tags as JSON. Use only those facts. Never invent amounts, dates, fees, interest, deadlines, laws or promises.

Legal citation:

- If `citation` is set, include its `text` exactly as given, once, as the only legal or contractual reference.
- If `citation` is null, cite nothing: no law, act, directive, regulation, statute, court, late fee or interest. Call the message a final notice.
- Never name any other law or clause, even if you know one.

Write it as the freelancer, in the first person, to the client by name:

- Three short paragraphs, serious and polite, never threatening.
- Say the invoice (number, amount due `amountDue` written exactly as given) was due on `dueDate` and is now `daysOverdue` days overdue, and that earlier reminders were sent.
- State the agreed payment terms (`paymentTerms`), as given.
- Ask for payment, or a reply to agree a plan, and say this is the final notice.
- If `installment` is set, say which installment this is, as given.
- Include the pay link (`payLink`) exactly as given, on its own line.
- Sign off with the freelancer's name.

Answer with only a JSON object, no code fence and no other text, with these keys:

- `subject`: one line, under 100 characters, starting with "Final notice:" and naming the invoice number.
- `body`: the email text, plain text with line breaks, no HTML.
