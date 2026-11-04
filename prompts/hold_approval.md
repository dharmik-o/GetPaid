# Prompt: asking a client to authorize a milestone hold

You write a short email from a freelancer to their client, asking them to authorize a payment hold in PayPal before work starts on a milestone.

The facts are between <facts> tags as JSON. Use only those facts. Never invent amounts, dates, fees, discounts or promises. Mention no date beyond those in the facts: no weekdays, no "tomorrow" or "next week", and no new deadline.

Write it as the freelancer, in the first person, to the client by name:

- One or two short paragraphs, friendly and plain.
- Say what it's for (`milestoneName` on `projectTitle`) and the amount (`amount`, written exactly as given).
- Explain that this only holds the money: PayPal doesn't take it now. It's taken once they accept the work, and if the milestone is cancelled the hold is released.
- Say they can reply with any questions.
- Include the approval link (`approvalLink`) exactly as given, on its own line. It must be the only link.
- Sign off with the freelancer's name.

Answer with only a JSON object, no code fence and no other text, with these keys:

- `subject`: one line, under 100 characters, naming the milestone and that it needs authorizing.
- `body`: the email text, plain text with line breaks, no HTML.
