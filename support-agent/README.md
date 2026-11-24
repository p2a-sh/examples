# Support agent

A p2a agent that answers questions about your documents, built on [`p2a-sdk`](https://github.com/p2a-sh/p2a-sdk). The same code runs as `support@p2a`.

It reads a document bundle, refuses questions the documents do not cover, and answers the rest with one model call. Account, billing, security, abuse, and legal questions get a fixed reply and an alert. The public prompt is in `prompts/system.md`. Publishing that file is safe: it only tells the model to stay on the documents. The per-deploy check string is created at runtime and is not in the prompt file.

## What you need

- Node 22 or newer
- A p2a account and a Custom agent token
- An OpenAI-compatible model key (the sample uses OpenCheap; any provider works)

## Quick start

```bash
cp .env.example .env
npm ci
npm run build
node dist/main.js run
```

`run` writes `STATE_DIR/bundle.json` when that file is missing or older than `BUNDLE_REFRESH_HOURS` (24 by default), then rebuilds on that interval. A failed rebuild keeps the previous file. `node dist/main.js build-bundle` still writes one bundle and exits.

Fill in `P2A_TOKEN` and `LLM_API_KEY` in `.env`. You can also point `P2A_TOKEN_FILE` and `LLM_API_KEY_FILE` at files. A file wins over the matching variable, and an empty file counts as unset.

Then message the agent from any p2a client.

## Model provider

The sample is set up for [OpenCheap](https://opencheap.si), an OpenAI-compatible API:

```bash
LLM_BASE_URL=https://api.opencheap.si/v1
LLM_MODEL=deepseek-v4-pro
OPENCHEAP_API_KEY=   # your key; LLM_API_KEY works too
```

[OpenRouter](https://openrouter.ai) works as an alternative. Point `LLM_BASE_URL` at `https://openrouter.ai/api/v1` with `LLM_MODEL=deepseek/deepseek-v4-pro` and your OpenRouter key, or keep OpenCheap as primary and set `OPENROUTER_API_KEY` plus both `FALLBACK_PRICE_*` values to use OpenRouter as the fallback. Any other OpenAI-compatible provider also works. Set `LLM_PRICE_IN_PER_M` and `LLM_PRICE_OUT_PER_M` to your provider's prices so the daily budget meter stays accurate.

`DRY_RUN=1` exits before the process reads a token. `node dist/main.js health` returns 0 when the process has written a fresh health file.

## Using your own documents

Set `DOCS_DIRS` to folders of markdown, MDX, text, HTML, TypeScript, or Python. Set `SOURCE_URLS` to public `http` or `https` pages. `DOCS_INCLUDE` and `DOCS_EXCLUDE` are extension or glob lists. `DOCS_BASE_URL` is the prefix for citation links.

```bash
node dist/main.js build-bundle --out bundle.json
```

`BUNDLE_STRICT=1` fails the build when a document contains a secret, a private address, or an email outside `ALLOWED_EMAILS`. With strict mode off, those chunks are dropped.

## Guardrails and cost

| Limit | Default |
|---|---|
| Input size | 2,000 characters |
| Output tokens | 4000 (reasoning models spend part of this on reasoning) |
| Reply size | 3,500 characters |
| Sender burst | 6 per 600 seconds, by sender id |
| Sender / owner / conversation per day | 30 / 60 / 20 |
| Daily model budget | 2.00 USD |
| Model calls per day | 3,000 |

Off-topic requests are refused before a model call, so they do not spend the budget. The daily budget pauses new model calls at 100 percent until the next UTC day. Alerts fire at 50 percent and 80 percent when `ALERT_TO` is set.

Stop the agent by creating a file named `KILL` in `STATE_DIR`, or set `ENABLED=0`. Both return the paused reply and accept no new connections. Remove the file or set `ENABLED=1` to resume.

## Bug reports

When `P2A_SUPPORT_LINEAR_API_KEY` and `P2A_SUPPORT_LINEAR_TEAM_KEY` are both set, a message that describes something broken in the product is filed on that Linear team. The sample team key is `P2A`. The process searches open issues first. A similar open issue gets a comment with the cleaned report, and the reply names the issue identifier. Otherwise it opens a new issue and adds the `Bug` label when that label exists. The reply includes the issue URL only when `P2A_SUPPORT_LINEAR_SHOW_URLS=1`.

The key is read from `P2A_SUPPORT_LINEAR_API_KEY_FILE` when that is set. A missing or empty file turns filing off, and the agent still answers. Account, billing, security, abuse, and legal messages stay on the human path. At most 20 new issues are opened per UTC day. The same sender and the same summary are filed once per 24 hours. Comments and issue text leave out email addresses, secrets, and the rest of the conversation.

A report that is still missing detail gets a short follow-up question, up to `CLARIFY_MAX_ROUNDS` (default 2, allowed 0 through 4). The agent keeps one open report per sender. Set the limit to 0 to file on the first message. An open report older than `CLARIFY_TTL_HOURS` (default 24, allowed 1 through 168) is dropped and is not filed. If the report is still thin after the last question, it is filed, and the needs-info label is applied when that label already exists. The agent does not create labels. If model calls are paused, the follow-up question is chosen without a model call. A question about how to do something is answered from the documents and leaves the open report as it is.

A file named `PAUSED` in `STATE_DIR` also pauses model calls. If the file contains only the word `budget`, the process wrote it because the daily budget was spent, and it removes that file at the next UTC midnight. Any other contents stay until you delete the file. Deleting a budget pause resumes calls for the rest of that day.

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
```

Keep tokens in files mounted into the container, not in the image.

## Evals

The cases in `evals/cases.jsonl` are synthetic. `npm test` runs them offline with a stand-in model and no network. The live run calls your configured model and prints pass or fail plus the total cost. It is not part of `npm test`.

```bash
node dist/main.js eval
```

## Links

- Guides: [p2a.sh/guides](https://p2a.sh/guides)
- SDK: [p2a-sh/p2a-sdk](https://github.com/p2a-sh/p2a-sdk)
- A smaller sample ships in the SDK as `support-ts`
