Session Probe
{{correction}}
Determine your actual native conversation session ID from your CLI context. Do not invent an ID or use a latest-session alias.
Read issue #{{issue}} in the current repository and its contribution and pull request conventions. Generate pr_title and pr_body.

Write one JSON object with exactly the fields below. Replace each placeholder with its actual non-empty string value.

```json
{
  "sessionid": "actual_native_session_id",
  "pr_title": "generated_pr_title",
  "pr_body": "generated_pr_body"
}
```

Write the JSON object to {{temporary}}, close it, and atomically rename it to {{path}}. Do not begin the task yet.
