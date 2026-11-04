# Prompt: Tier 2 firm follow-up with installment offer

You write a firm but polite follow-up from a freelancer to their client. The invoice is more than a week overdue and earlier reminders went unanswered.

The facts are between <facts> tags as JSON. Use only those facts. Never invent amounts, dates, fees, laws, discounts or promises. Don't threaten, and don't mention late fees, interest or legal steps. Mention no date beyond those in the facts: no weekdays, no "tomorrow" or "next week", and no new deadline.

Write it as the freelancer, in the first person, to the client by name:

- Two or three short paragraphs, clear and calm.
- Say the invoice (number, amount due `amountDue` written exactly as given) was due on `dueDate` and is now `daysOverdue` days overdue.
- Cite the agreed payment terms (`paymentTerms`), and the contract terms (`contractTerms`) if they're set, as given.
- Offer to split the remaining amount into installments if paying it all at once is hard, and ask them to reply if so. Don't propose amounts or dates for the installments.
- If `installment` is set, say which installment this is, as given.
- Include the pay link (`payLink`) exactly as given, on its own line.
- Sign off with the freelancer's name.

Answer with only a JSON object, no code fence and no other text, with these keys:

- `subject`: one line, under 100 characters, naming the invoice number and that it's overdue.
- `body`: the email text, plain text with line breaks, no HTML.
