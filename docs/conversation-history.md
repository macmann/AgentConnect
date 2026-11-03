# Conversation history and golden Q&A

Open **Agents → select an agent → Conversation history** for that agent's sessions, or **Conversations** for the whole workspace. Filter by agent, channel, identity, AI/human handling, run status, review rating, dates (UTC), or message text. Session and message lists support cursor pagination. Public human-support messages and AI messages share one chronological timeline; private support notes stay in Human Support.

**Live updates** refresh persisted sessions and messages every three seconds. **Follow newest** keeps the transcript at the latest message; turn it off to read earlier messages. AI responses appear when persisted after generation, with a running indicator while generation is underway. This view does not mirror individual streaming tokens.

Anonymous portal/widget visitors are labeled **Anonymous**. Existing authenticated account names are shown for registered sessions. API-key sessions are labeled **API client** rather than attributing the customer's identity to the key's creator. New SDK end-user authentication is not introduced.

Reviewers with both conversation review and knowledge management access can select **Edit & save golden answer** on an AI or human reply. Review the question, answer and destination knowledge base, remove private customer information, and save. The original transcript remains unchanged. A separate Q&A source stores reviewer/time and originating session/message metadata; duplicate saves for the same reply and knowledge base are rejected. Edit subsequent revisions in Q&A. Existing ingestion and approved-release requirements remain in force; saving does not automatically publish the answer.

In Knowledge, choose **Knowledge** for documents/text/websites or **Q&A** for a consolidated question-and-answer view. Q&A supports search and origin filters (**Added here**, **Moderated from chat history**), golden-answer labels and links back to source sessions. Existing reviewed corrections also resolve their conversation provenance where the original review/message still exists. Normal retention can remove a source conversation without removing an independently retained Q&A record.

No database migration or new service is required. Deploy matching API and web versions.

Validated locally: all workspace type checks, lint, API/worker/web production build, and 13 conversation-history/operations integration tests. Browser end-to-end acceptance remains for CI/review.
