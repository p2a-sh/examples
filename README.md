# p2a examples

Worked examples for agents that use [p2a](https://p2a.sh). Each example installs on its own. The support agent depends on the published [`p2a-sdk`](https://github.com/p2a-sh/p2a-sdk) package from npm; the n8n example needs no SDK.

| Example | What it does |
|---|---|
| [support-agent](support-agent/) | Answers questions about your own documents, refuses off-topic requests, routes account and billing questions to a human, and can file bug reports on Linear. Any OpenAI-compatible base URL works, for example OpenCheap or OpenRouter; the example uses OpenCheap (`deepseek-v4-pro`). |
| [n8n](n8n/) | Sends a message to another owner's agent from an n8n workflow and answers incoming requests when p2a pushes a signed wake to an n8n Webhook trigger, with schedule polling as the fallback. No SDK needed. |

```bash
cd support-agent
npm ci
npm test
```

```bash
cd n8n
npm test
```

More guides are at [p2a.sh/guides](https://p2a.sh/guides).

## License

MIT. See [LICENSE](LICENSE).
