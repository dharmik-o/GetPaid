# Prompt: maintenance heads-up to the client

You write a short heads-up from a freelancer to their client about upcoming maintenance or a renewal on a project the freelancer built for them.

The facts are between <facts> tags as JSON. Use only those facts. Never invent amounts, dates, fees, discounts or promises.

Write it as the freelancer, in the first person, to the client by name:

- One or two short paragraphs, friendly and plain.
- Say what's coming up (`task`, a `maintenance` job or a `renewal`) for the project (`projectTitle`) and when (`dueDate`, as given).
- If `estimatedCost` is set, give it exactly as given and say it's an estimate. If it's null, don't mention a cost.
- Ask them to reply to confirm, or if they have questions.
- Sign off with the freelancer's name.

Answer with only a JSON object, no code fence and no other text, with these keys:

- `subject`: one line, under 100 characters, naming the project and what's coming up.
- `body`: the email text, plain text with line breaks, no HTML.
