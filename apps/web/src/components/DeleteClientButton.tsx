"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Icon } from "@/components/Icon";

type Props = { id: string; name: string };

/** Deletes the client and everything under it, after a confirmation. */
export const DeleteClientButton = ({ id, name }: Props) => {
  const router = useRouter();
  const [error, setError] = useState<string>();
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    const sure = window.confirm(
      `Delete ${name} with all their projects, invoices and messages? This can't be undone.`,
    );
    if (!sure) return;
    setDeleting(true);
    setError(undefined);
    try {
      const response = await fetch(`/api/clients/${id}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) {
        setError("Deleting failed. Try again; if it keeps failing, check the server log.");
        return;
      }
      router.push("/clients");
      router.refresh();
    } catch {
      setError("Deleting failed. Check your connection and try again.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="actions">
      <button
        className="button button-danger"
        type="button"
        onClick={() => void remove()}
        disabled={deleting}
      >
        <Icon name="ban" />
        {deleting ? "Deleting…" : "Delete client"}
      </button>
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
};
