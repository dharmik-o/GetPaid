// Browser-side JSON calls to the dashboard's own API, with errors turned into one readable
// sentence. Pure fetch: safe in client components; holds no secrets.

type ApiBody = { error?: string; errors?: { field: string; message: string }[] };

export type CallResult = { ok: true } | { ok: false; message: string };

/** "items.1.dueDate" → "Installment 2 due date"; other fields by the given names. */
export const fieldLabel = (field: string, names: Record<string, string>): string => {
  const item = /^items\.(\d+)\.(amountCents|dueDate)$/.exec(field);
  if (item) {
    const what = item[2] === "dueDate" ? "due date" : "amount";
    return `Installment ${String(Number(item[1]) + 1)} ${what}`;
  }
  return names[field] ?? field;
};

const messageOf = (body: ApiBody, names: Record<string, string>): string => {
  const first = body.errors?.[0];
  if (first) return `${fieldLabel(first.field, names)} ${first.message}`;
  return body.error ?? "That didn't work. Try again.";
};

export const sendJson = async (
  url: string,
  method: "POST" | "PUT" | "DELETE",
  body: unknown,
  names: Record<string, string>,
): Promise<CallResult> => {
  try {
    const response = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return { ok: true };
    return { ok: false, message: messageOf((await response.json()) as ApiBody, names) };
  } catch {
    return {
      ok: false,
      message: "That didn't reach the server. Check your connection and try again.",
    };
  }
};
