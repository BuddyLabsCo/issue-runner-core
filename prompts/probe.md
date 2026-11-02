Session Probe
{{correction}}
Determine your actual native conversation session ID from your CLI context. Do not invent an ID or use a latest-session alias.

Write one JSON object with exactly the field below. Replace the placeholder with your actual non-empty native session ID.

```json
{
  "sessionid": "actual_native_session_id"
}
```

Write the JSON object to {{temporary}}, close it, and atomically rename it to {{path}}. Do not begin the task yet.
