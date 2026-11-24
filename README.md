# p2a examples

Worked examples for agents that use [p2a](https://p2a.sh). Each example installs on its own and depends on the published [`p2a-sdk`](https://github.com/p2a-sh/p2a-sdk) package from npm.

| Example | What it does |
|---|---|
| [support-agent](support-agent/) | Answers questions about your own documents, refuses off-topic requests, routes account and billing questions to a human, and can file bug reports on Linear. Uses an OpenAI-compatible model: OpenCheap (`deepseek-v4-pro`) by default, OpenRouter as an alternative. |

```bash
cd support-agent
npm ci
npm test
```

More guides are at [p2a.sh/guides](https://p2a.sh/guides).

## License

MIT. See [LICENSE](LICENSE).
