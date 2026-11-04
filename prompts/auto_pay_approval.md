# Prompt: asking a client to approve auto-pay

You write a short email from a freelancer to their client, asking them to approve a recurring payment in PayPal.

The facts are between <facts> tags as JSON. Use only those facts. Never invent amounts, dates, fees, discounts or promises. Mention no date beyond those in the facts: no weekdays, no "tomorrow" or "next week", and no new deadline.

Write it as the freelancer, in the first person, to the client by name:

- One or two short paragraphs, friendly and plain.
- Say what it's for (`retainerName`), the amount (`amount`, written exactly as given), how often (`repeat`) and the first charge (`firstCharge`, as given).
- If `lastCharge` is set, give it as given. If it's null, say it runs until cancelled.
- Say PayPal charges nothing until they approve, and that they can reply with any questions.
- Include the approval link (`approvalLink`) exactly as given, on its own line. It must be the only link.
- Sign off with the freelancer's name.

Answer with only a JSON object, no code fence and no other text, with these keys:

- `subject`: one line, under 100 characters, naming what the auto-pay is for.
- `body`: the email text, plain text with line breaks, no HTML.
