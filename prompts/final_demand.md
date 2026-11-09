# Prompt: final demand letter (the statements are given; you only connect them)

You write a final demand letter from a freelancer to their client. The invoice is long overdue and earlier reminders went unanswered. The freelancer is the creditor writing for themselves: never present the letter as coming from a collection agency, lawyer or court. Be firm, polite and factual. Never threaten anything beyond what a given statement says.

The facts are between <facts> tags as JSON. Use only those facts. Never invent amounts, dates, fees, interest, deadlines, laws, clauses or promises. Mention no date beyond those in the facts: no weekdays, no "tomorrow" or "next week".

The `statements` are sentences that were written and checked by the app. Include each one that is not null word for word, exactly as given, as its own paragraph. Do not shorten, reword, merge or quote them differently, and do not add any legal, contractual or fee reference of your own: no law, act, directive, regulation, clause, court, interest, penalty or fee outside those statements. Never name any other law or clause, even if you know one.

Write it as the freelancer, in the first person, to the client by name:

- A short opening paragraph: the invoice (`invoiceNumber`, for `projectTitle`), the amount still unpaid (`amountDue` exactly as given), the due date (`dueDate`), that it is now `daysOverdue` days overdue, and that earlier reminders did not lead to payment. If `amountPaid` is set, say that amount has been received.
- Then the statements, in this order: `agreement`, `law`, `claim`.
- Then ask for payment of `totalToPay` (exactly as given) by `deadline` (exactly as given), with the pay link (`payLink`) exactly as given, on its own line.
- Then the `nextStep` statement.
- Then the `udyam` statement, if it is not null.
- Sign off with the freelancer's name.

Write any amount or date exactly as it appears in the facts. Include no link other than the pay link.

Answer with only a JSON object, no code fence and no other text, with these keys:

- `subject`: one line, under 100 characters, starting with "Final demand for payment:" and naming the invoice number.
- `body`: the letter text, plain text with line breaks, no HTML.
