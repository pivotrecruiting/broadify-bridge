# Engine Connection Lifecycle

## ATEM IP: library self-heal → status connecting → connected

The ATEM IP adapter lets the `atem-connection` library handle short network
outages on an already connected switcher. When the library emits
`disconnected` after a working connection, Bridge reports the engine as
`connecting` and keeps the current macro list instead of clearing it.

When the same library instance emits `connected` again, Bridge reports
`connected`, clears the transient error fields, and refreshes macros from the
current ATEM state. This keeps relay commands and UI state aligned with the
switcher after the library has recovered its socket.

The initial connect attempt still fails on real `Error` instances and on the
configured connect timeout. Library-internal string error events during the
connect phase are treated as parser/runtime noise and do not reject the connect
promise; once connected, runtime error events continue to update the engine
error message without forcing a disconnect.

Disconnect and failed connect cleanup destroy the ATEM library instance so the
threaded worker and UDP socket are released. A bridge-side supervisor for
longer outages is planned for a later PR; this adapter does not add a separate
bridge reconnect loop.
