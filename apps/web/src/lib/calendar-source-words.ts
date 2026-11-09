// Pure, safe in client components: what a failed import means, in plain words.

export const SOURCE_ERROR_WORDS: Record<string, string> = {
  unreachable:
    "We couldn't reach this calendar. Check the address, and that the calendar still exists.",
  not_ics: "That address didn't give back a calendar file. Copy the secret iCal address again.",
  too_large: "This calendar is larger than 5 MB, so it wasn't imported.",
  blocked_address: "This address isn't allowed: it must be a public https address.",
  timeout: "The calendar took longer than 10 seconds to answer.",
  http_error:
    "The calendar's server said no. The secret address may have been reset: copy it again from your calendar.",
};
