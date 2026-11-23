# Read It Later + AI Research Assistant: What to Hand-Code

# Guiding Principle
Do not spend your learning time re-implementing CRUD patterns you
already understand. Use AI assistance for repetitive scaffolding and
routine endpoints, but personally design, implement, test, and debug the
parts where correctness, concurrency, reliability, retrieval quality,
and orchestration matter. AI-generated code is still your
responsibility: review it, understand it, and make sure it follows the
domain rules you define.

1. Safe to Scaffold with AI Assistance
These tasks can be generated with AI and reviewed by you:
- Standard CRUD endpoints for bookmarks, collections, tags, and notes.
- Basic DTOs, validation, controller/service wiring, and routine
  repository methods.
- Authentication integration and ordinary authorization guards.
- Pagination, sorting, filtering, and basic list endpoints.
- Straightforward migrations and entity setup.
- Basic frontend forms, tables, loading states, and detail pages.
- API documentation and repetitive test fixtures.
Review generated code for validation, authorization, data ownership,
query efficiency, and consistency with your schema. Do not accept code
you cannot explain.

2. Parts You Should Hand-Code

A. Content ingestion pipeline
- Define ingestion stages and legal state transitions.
- Fetch content with timeouts, size limits, redirect limits, and safe
  URL handling.
- Extract readable article content and normalize metadata.
- Handle unsupported pages, empty extraction, malformed HTML, and
  transient network failures.
- Make each stage independently retryable.
- Preserve original URLs and source metadata.
- Decide how to handle canonical URLs, duplicate saves, and changed
  page content.
Why: This is the foundation of the product and teaches you to design
robust pipelines around unreliable external systems.

B. Job processing and distributed-systems behavior
Use BullMQ for queue mechanics initially, but hand-code the business
rules:
- Job lifecycle and legal state transitions.
- Idempotency and deduplication rules.
- Retry classification: transient versus permanent failures.
- Exponential backoff and retry limits.
- Dead-letter handling and manual replay.
- Worker concurrency limits and provider-specific rate limits.
- Recovery when a worker crashes midway through a stage.
- Prevention of stale workers overwriting newer results.
- Safe handling of duplicate job delivery.
BullMQ does not make the entire business workflow exactly-once. Design
around duplicate delivery and make processing safe to repeat.

C. Database correctness and concurrency
- Unique constraints for canonical resource identity and idempotency
  keys.
- Atomic claiming or transitioning of work.
- Transactions around related database updates.
- Row-level locking where appropriate.
- Optimistic concurrency or version checks where appropriate.
- Isolation-level decisions for operations that need them.
- Indexes for common filters and retrieval paths.
- Safe updates when ingestion and user edits happen concurrently.
- Query plans and performance checks as the library grows.
Use PostgreSQL features intentionally. Identify the race or invariant a
lock or transaction protects before adding it.

D. Content chunking and embedding pipeline
- Chunking strategy and chunk boundaries.
- Metadata attached to every chunk: resource ID, title, URL, section,
  and position.
- Embedding input preparation.
- Batch sizing and provider limits.
- Embedding persistence and model/version tracking.
- Re-embedding when source content or embedding models change.
- Recovery from partial embedding failures.
Evaluate chunking against real articles rather than assuming one chunk
size works for everything.

E. Retrieval and RAG pipeline
- Query normalization and query embedding.
- Vector similarity retrieval.
- PostgreSQL full-text retrieval.
- Hybrid result merging.
- Metadata filtering by collection, tag, source, or date.
- Deduplication of retrieved passages.
- Reranking.
- Context selection under token limits.
- Prompt construction.
- Source attribution and citation mapping.
- Handling insufficient or conflicting evidence.
- Returning answers grounded in retrieved sources.
Measure retrieval quality with representative questions and expected
source passages. A fluent answer is not proof that retrieval worked.

F. AI assistant and tool orchestration
- Define strict schemas for tools and their inputs.
- Validate tool arguments before execution.
- Separate model decisions from application-side authorization.
- Implement tools such as searchLibrary, getResource,
  getRelatedResources, and createCollection.
- Track tool calls, outputs, errors, and execution status.
- Limit tool-call count, execution time, and token usage.
- Handle malformed arguments and model/provider failures.
- Persist conversation and workflow state.
- Add human approval before destructive or consequential actions.
- Prevent repeated tool execution from creating duplicate side
  effects.
The model may propose an action; your backend must decide whether it is
valid and permitted.

G. Reliability, observability, and testing
- Unit tests for state transitions, chunking, and retrieval assembly.
- Integration tests for PostgreSQL transactions and constraints.
- Worker tests for duplicate delivery, retries, and crashes.
- Tests for simultaneous saves and competing workers.
- Tests for external provider timeouts and rate limits.
- Structured logs with resource IDs, job IDs, and workflow IDs.
- Metrics for ingestion duration, failures, queue age, and retrieval
  latency.
- Tracing across API requests, jobs, and AI calls.
- Failure-injection and load tests for critical workflows.
3. What AI Can Generate vs. What You Own
  Area                    AI can scaffold         You should own
  Bookmark CRUD           Controllers, DTOs,      Identity rules,
routine endpoints       deduplication,
ownership

  Collections and tags    Standard CRUD and UI    Relationships and
integrity constraints

  Authentication          Integration boilerplate Authorization
boundaries and security
review

  Ingestion               Queue registration      Pipeline stages,
boilerplate             extraction, recovery

  Workers                 Basic processor         Idempotency, retries,
structure               concurrency, state
transitions

  Database                Basic migrations and    Constraints,
models                  transactions, locking,
indexes

  Embeddings              Provider SDK setup      Chunking, batching,
versioning, recovery

  RAG                     Basic SDK call          Retrieval, hybrid
search, reranking,
context and citations

  Agent tools             Type definitions and    Validation,
wiring                  permissions, execution
limits, durable state
Testing                 Routine fixtures and    Race-condition,
simple tests            failure, integration,
and quality tests
4. Recommended Implementation Order
1. Define the domain and invariants. Decide what a resource is, how
   duplicates are identified, what processing states exist, and which
   transitions are allowed.
2. Scaffold ordinary application plumbing. Use AI for routine CRUD,
   authentication integration, and basic UI.
3. Hand-code URL ingestion. Make fetching and extraction safe,
   observable, and independently testable.
4. Hand-code asynchronous processing behavior. Add job state,
   idempotency, retries, failure recovery, and concurrency controls.
5. Hand-code the AI indexing pipeline. Implement chunking,
   embeddings, persistence, and reprocessing.
6. Hand-code retrieval. Start with vector search, then add
   full-text search, hybrid retrieval, reranking, and citations.
7. Hand-code tool orchestration. Add validated tools, persisted
   execution state, limits, and approval gates.
8. Prove reliability. Simulate duplicate jobs, worker crashes,
   provider timeouts, concurrent updates, and partial failures.
5. Definition of Done for Your Learning Goals
For each core subsystem, be able to explain:
- What invariant does it protect?
- What can fail, and at which exact point?
- Can the operation be safely repeated?
- What happens if two workers or requests run concurrently?
- Which data must be committed atomically?
- How does the system recover?
- What evidence tells you it is working correctly?
- What trade-off did you choose, and what alternative did you reject?
The goal is not to hand-write every line. The goal is to personally own
the system's important decisions and correctness properties. Use AI to
save time on familiar plumbing so you can spend that time understanding,
implementing, and testing the difficult backend and AI engineering.
