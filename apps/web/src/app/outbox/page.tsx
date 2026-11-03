import { ComingSoon } from "@/components/ComingSoon";

// Outbox: review drafts, approve / edit / skip / reschedule. Built in M6.

const OutboxPage = () => (
  <ComingSoon
    title="Outbox"
    what="Reminder drafts will wait here for you to approve, edit, skip or reschedule. No drafts are made yet."
    milestone="M6 (Approvals)"
  />
);

export default OutboxPage;
