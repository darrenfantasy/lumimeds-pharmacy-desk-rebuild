# Pharmacy Desk

A TypeScript service for the LumiMeds take-home. It receives emails and orders at `POST /webhooks`, uses Claude to extract proposed changes from emails, and sends each order to an eligible pharmacy or `MANUAL`. Emails that need a decision go on Sam's review list.

This is a timed rebuild of an exercise I had worked on before. It uses the [original exercise](https://github.com/Lumimeds/take-home-pharmacy-desk/blob/9165972991c6d2a67df001f363c8028256c2ca44/README.md) and the [official simulator and fictional data](sim/README.md).

## Run it

Use Node.js 18.20 or newer and run these commands from the repository root.

```bash
npm ci
cp .env.example .env
# Set ANTHROPIC_API_KEY in .env using a key from your own account.
npm start
```

Run the simulator in a second terminal.

```bash
node sim/sim.mjs --target http://localhost:3000/webhooks
```

Claude Sonnet 4.6 is the default. Set `PHARMACY_LLM_MODEL` to use another Claude model that supports structured outputs. Restart the service before rerunning the same fixture so the simulator's repeated start event is treated as a fresh run.

| Output | File |
|---|---|
| Actual dispatches | `out/run-log.jsonl` |
| Webhook delivery results | `out/deliveries.jsonl` |
| Sam's review list | `out/review-queue.jsonl` |

## Dispatch decisions

I chose TypeScript and Node's built-in HTTP server because the simulator sends one event at a time to a single endpoint. The service separates Claude's email extraction from the routing rules, so the same dispatch logic can run in tests without a model call.

1. **Check the source.** Pharmacy contacts can report their own fulfillment facts. Ops can set scoped routing preferences and exclusions. For safety-sensitive changes, the service checks the proposed scope, value, and effective window against the email. Independently verified restrictions still apply when the email goes to review. Conflicting inventory puts the affected pharmacy, drug, and dose on hold until a later confirmation.
2. **Use the event clock.** Daily capacity resets at midnight in US Eastern time. I interpret “until Wednesday” as ending when Wednesday begins and “the rest of the week” as ending when Monday begins. Time windows are tied to the clauses that specify them, so two instructions in one email can take effect at different times.
3. **Choose a destination.** First check operating hours, state eligibility, exact dose, and remaining capacity. Apply Ops exclusions to the eligible set, then consider preferences. The latest instruction supersedes earlier instructions for the same scope. Among eligible preferences, more matching scope fields take priority, with recency breaking ties. Without an eligible preference, rank by shipping time, then price, then pharmacy ID. Use `MANUAL` when no candidate remains.
4. **Handle uncertainty.** The service reserves capacity before dispatch and counts an order once across redeliveries. If the response is uncertain, it retains that reservation and retries the same destination only while it remains eligible on the same Eastern day. If Claude is unavailable, the service holds the affected pharmacy or, for an Ops email, all pharmacies. Recovery retries the original email and releases that email's hold once it has been processed.

## Verification

Run `npm test` after installing dependencies. All **62 tests passed** without an API key. The suite includes an end-to-end Week A run against the official simulator and regression cases for stock conflicts, missing or reversed restrictions, shifted time windows, and outage recovery. [Week A test](test/week-a.test.mjs) · [Dispatch safety tests](test/safety-routing.test.mjs) · [Webhook tests](test/webhook.test.mjs)

I ran the following datasets with hosted Claude Sonnet 4.6, then replayed the recorded responses against the final code. Each order was checked against its expected destination.

| Dataset | Events acknowledged | Destinations matched |
|---|---:|---:|
| Official Week A | 52/52 | 38/38 |
| Synthetic boundary week | 20/20 | 11/11 |
| Targeted safety cases | 13/13 | 8/8 |

Across these replays, there were no missing, late, or duplicate dispatches. Week A produced five `MANUAL` routes and two review entries as expected.

## Scope and production changes

I spent the time box on dispatch correctness, redelivery, and regression tests. This version runs in one process, keeps routing state in memory, and uses a JSONL file for operator review. The evaluator's unseen fixture is untested. Source checks cover supported wording and time formats, and unfamiliar or unresolved statements can require human review.

Before production, I would authenticate webhooks and sender identities, persist rules and dispatch reservations transactionally for restart recovery, and build an operator workflow for approving reviews and reconciling uncertain dispatches. I would measure extraction quality on labeled, representative emails before expanding the supported formats.

## AI use

I used Codex and its agents to implement, test, and review the rebuild. I changed the first retry implementation after review found that reusing the original reservation could send an order to a pharmacy that had since closed. The service now rechecks eligibility before retrying, and a regression verifies that closure prevents a second dispatch request.
