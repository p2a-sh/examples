# Support agent

A p2a agent that answers questions about your documents, built on [`p2a-sdk`](https://github.com/p2a-sh/p2a-sdk). The same code runs as `support@p2a`.

It reads a document bundle, refuses questions the documents do not cover, and answers the rest with one model call. Account, billing, security, abuse, and legal questions get a fixed reply and an alert. The public prompt is in `prompts/system.md`. Publishing that file is safe: it only tells the model to stay on the documents. The per-deploy check string is created at runtime and is not in the prompt file.

## What you need

- Node 22 or newer
- A p2a account and a Custom agent token
- The agent works with any OpenAI-compatible base URL, such as [OpenCheap](https://opencheap.si) or [OpenRouter](https://openrouter.ai). This example uses OpenCheap because it routes to the cheapest LLM provider and is usually cheaper than OpenRouter. Set `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY`.

## Quick start

```bash
cp .env.example .env
npm ci
npm run build
node dist/main.js run
```

`run` writes `STATE_DIR/bundle.json` when that file is missing or older than `BUNDLE_REFRESH_HOURS` (24 by default), then rebuilds on that interval. A failed rebuild keeps the previous file. `node dist/main.js build-bundle` still writes one bundle and exits.

Fill in `P2A_TOKEN`, `P2A_URL`, and `LLM_API_KEY` in `.env`. `P2A_URL` is the agent MCP URL, and `run` requires it. You can also point `P2A_TOKEN_FILE` and `LLM_API_KEY_FILE` at files. A file wins over the matching variable, and an empty file counts as unset.

`P2A_LISTEN_MODE` is `stream` by default. Set it to `poll` to poll instead.

Then message the agent from any p2a client.

`DRY_RUN=1` exits before the process reads a token. `node dist/main.js health` returns 0 when the process has written a fresh health file.

## Using your own documents

Set `DOCS_DIRS` to folders of markdown, MDX, text, HTML, TypeScript, or Python. Set `SOURCE_URLS` to public `http` or `https` pages. `DOCS_INCLUDE` and `DOCS_EXCLUDE` are extension or glob lists. `DOCS_BASE_URL` is the prefix for citation links.

```bash
node dist/main.js build-bundle --out bundle.json
```

`BUNDLE_STRICT=1` rejects a new bundle when a document contains a secret, a private address, or an email outside `ALLOWED_EMAILS`. The previous bundle stays in use. If there is no previous bundle, the agent runs with an empty bundle and refuses document questions. With strict mode off, a matching chunk is left out and the rest of the document is kept.

## Guardrails and cost

| Limit | Default |
|---|---|
| Input size | 2,000 characters |
| Output tokens | 4000 (reasoning models spend part of this on reasoning) |
| Reply size | 3,500 characters |
| Sender burst | 6 per 600 seconds, by sender id. An allowlisted relay DID is limited per conversation |
| Sender / owner / conversation per day | 30 / 60 / 20 |
| Daily model budget | 2.00 USD |
| Model calls per day | 3,000 |

Off-topic requests are refused before a model call, so they do not spend the budget. The daily budget pauses new model calls at 100 percent until the next UTC day. Alerts fire at 50 percent and 80 percent when `ALERT_TO` is set. `RELAY_DIDS` lists gateway DIDs that are limited per conversation. Every other sender, including one whose owner could not be resolved, is limited per DID.

Stop the agent by creating a file named `KILL` in `STATE_DIR`, or set `ENABLED=0`. Both return the paused reply and accept no new connections. Remove the file or set `ENABLED=1` to resume.

## Bug reports

When `P2A_SUPPORT_LINEAR_API_KEY` and `P2A_SUPPORT_LINEAR_TEAM_KEY` are both set, a bug report, feature request, or feedback note about the product is filed on that Linear team. The sample team key is `P2A`. The process searches open issues first. A similar open issue gets a comment with the cleaned report, and the reply names the issue identifier. Otherwise it opens a new issue. The title is at most 70 characters and starts with exactly one of Bug, Feature, or Feedback. Sender lines, greetings, and a kind prefix already in the message are removed first. A title returned by the clarify model is used when that call runs; otherwise the title is cleaned from the report. The reply names that kind, for example "I opened P2A-9 as a feature request". The matching label is applied when it already exists: `Bug`, `Feature`, or `Feedback`, or the names in `P2A_SUPPORT_LINEAR_BUG_LABEL`, `P2A_SUPPORT_LINEAR_FEATURE_LABEL`, and `P2A_SUPPORT_LINEAR_FEEDBACK_LABEL`. A team label is used when the team has one; otherwise a workspace label with the same name is used. The reply includes the issue URL only when `P2A_SUPPORT_LINEAR_SHOW_URLS=1`. A report filed on the first message is logged as `report_filed` with `clarified` false. The same event is used after a clarifying question, with `clarified` true.

The key is read from `P2A_SUPPORT_LINEAR_API_KEY_FILE` when that is set. A missing or empty file turns filing off, and the agent still answers. Account, billing, security, abuse, and legal messages stay on the human path. At most 20 new issues are opened per UTC day. The same sender and the same summary are filed once per 24 hours. Comments and issue text leave out email addresses, secrets, and the rest of the conversation.

A report that already says what happened or what is wanted is filed on the first message. The agent asks a follow-up only when it cannot tell what the problem or request is. That question is one or two short points, and it tells the sender they can reply "file it" to file the report as written. The next reply files the original report plus any extra detail. "file it", "as is", "just file it", and any other reply all file it. The agent does not ask a second time, and it does not refuse to file because detail is missing. It keeps one open report per sender. An allowlisted relay DID keeps one open report per conversation. `CLARIFY_MAX_ROUNDS` 0 files on the first message. Any higher value still asks at most once (default 1, allowed 0 through 4). An open report older than `CLARIFY_TTL_HOURS` (default 24, allowed 1 through 168) is dropped and is not filed. If the report is still unclear when it is filed, the needs-info label is applied when that label already exists. The agent does not create labels. If model calls are paused, the follow-up question is chosen without a model call. A question about how to do something is answered from the documents and leaves the open report as it is.

A file named `PAUSED` in `STATE_DIR` also pauses model calls, and new connections stay pending while it exists. If the file contains only the word `budget`, the process wrote it because the daily budget was spent, and it removes that file at the next UTC midnight. Any other contents stay until you delete the file. Deleting a budget pause resumes calls for the rest of that day.

## Answers

Answers are never cached. Each reply is generated for that message from the public documents only, so one visitor's answer is never reused for another.

`node dist/main.js stats` prints the counters in `STATE_DIR`, including model calls and injection leaks.

## Connections

`CONNECTION_POLICY=accept_capped` accepts new connections until `ACCEPTS_PER_DAY`, then leaves them pending and sends one alert that day. `manual` leaves every request pending. A blocklisted owner is blocked. The agent never declines.

Run this agent on a dedicated account. `STATE_DIR/blocklist.txt` is one owner per line. Blank lines and lines starting with `#` are ignored. A leading `@` is optional.

Alerts go only to `ALERT_TO`, and only as fixed sentences. They do not include the visitor's message. If `ALERT_TO` is unset, the process logs the alert category and does not send.

## Docker

The container listens to p2a and does not publish a port.

```yaml
services:
  support-agent:
    build: .
    env_file: .env
    read_only: true
    environment:
      STATE_DIR: /state
    volumes:
      - support-state:/state
volumes:
  support-state:
```

Keep tokens in files mounted into the container, not in the image.

## Evals

The cases in `evals/cases.jsonl` are synthetic. `npm test` runs them offline with a stand-in model and no network. The live run calls your configured model and prints pass or fail plus the total cost. It uses a temporary state directory, reads `bundle.json` from the `STATE_DIR` you set, and does not file Linear issues. It is not part of `npm test`.

```bash
node dist/main.js eval
```

## Links

- Guides: [p2a.sh/guides](https://p2a.sh/guides)
- SDK: [p2a-sh/p2a-sdk](https://github.com/p2a-sh/p2a-sdk)
- A smaller sample ships in the SDK as `support-ts`
