# Product screenshots

Captured with Chromium from the running development application. All accounts, documents, conversations and provider responses are explicit test/sample data. Images demonstrate the product UI, not real provider acceptance or a production customer environment.

| Image                                     | View                                            |
| ----------------------------------------- | ----------------------------------------------- |
| [RAG overview](rag-agent-overview.png)    | Agent identity, readiness and attachments       |
| [Dark RAG overview](rag-agent-dark.png)   | Agent configuration in dark mode                |
| [Dark workflows](workflow-dark.png)       | Workflow canvas, controls and configuration     |
| [Dark widget](chat-widget-dark.png)       | Embedded chat with dark rich responses          |
| [Dark sign-in](sign-in-dark.png)          | Mobile authentication and theme switcher        |
| [RAG knowledge](rag-agent-knowledge.png)  | Ready knowledge attachment and retrieval policy |
| [RAG prompt](rag-agent-prompt.png)        | Structured prompt editing                       |
| [Grounded chat](rag-agent-chat.png)       | Hosted answer and source citation               |
| [Desktop widget](chat-widget-desktop.png) | Customer widget with workflow and rich response |
| [Mobile widget](chat-widget-mobile.png)   | Responsive embedded customer chat               |

To regenerate, initialize local services, start the API/web/worker with the test-provider grants described by the scenario files, then run:

```sh
PRODUCT_SCREENSHOTS=1 pnpm test:e2e tests/browser/product-theme.spec.mjs tests/browser/knowledge.spec.mjs tests/browser/customer-engagement.spec.mjs
```

These scenarios need temporary model endpoint exceptions for `127.0.0.1:4546` and `127.0.0.1:4568`, and a website-crawl exception for `127.0.0.1:4546`. Keep these fixture destinations out of normal/production configuration. The widget test serves its sample website on port 4569. Scenario cleanup removes its generated fixture records and objects.
