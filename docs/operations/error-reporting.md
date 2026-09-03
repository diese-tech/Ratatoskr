# Operational error reporting

Ratatoskr sends concise actionable failures to the existing managed `staff-ops`
channel. Detailed redacted error/stack data stays in Railway process logs. Private
interaction replies and staff reports share a reference; search Railway for that
reference to find `operation_failed` and any `staff_report_unavailable` event.

The destination is the server-managed `admin/staff_ops/text_channel` resource.
Bootstrap must have registered it. Error handling never creates, adopts by name,
renames, or changes permissions on a channel. If the binding is missing, an admin
can preview and run normal server bootstrap after reviewing its changes.

Reports require a channel in the expected guild, bot send access, and staff-only
visibility. Allfather, Aesir and Valkyries use managed role IDs (configured ADMIN
IDs are also recognized). Effective access for other roles and explicit member
overwrites is checked. A public or broader-access channel causes a fallback to
Railway; inspect the `staff_report_unavailable` reason and repair through the
normal administrative workflow.

Repeated failures of the same action/setup/type share a reference and suppress
additional staff alerts for 60 seconds, with a bounded in-process cache. Every
occurrence still gets a structured log. Suppressed alerts do not claim delivery
unless the original send was confirmed. Failed reporting never changes roster
state or recursively reports itself. Discord mentions are disabled; credentials
from environment variables and connection-URL passwords are redacted in logs.

For pending roster writes, read the saved-state explanation before retrying. A
saved roster with uncertain Discord delivery must recover; repeating the player
change is not a repair. See `scout-workflow.md` for the recovery procedure.

Deployment check: force a controlled failure in an approved test setup, verify its
private response and staff-only report share a reference, and locate the matching
Railway entry. A successful deployment or test run does not perform this live check.
