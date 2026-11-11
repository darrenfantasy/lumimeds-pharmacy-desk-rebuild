# Pharmacy Desk

A TypeScript webhook service for the LumiMeds take-home. It reads pharmacy and Ops emails with Claude, checks the proposed changes, then sends orders to an eligible pharmacy or to `MANUAL`. Sam's review list is written to `out/review-queue.jsonl`.

This is a timed rebuild of an exercise I had worked on before. It uses the [original exercise](https://github.com/Lumimeds/take-home-pharmacy-desk/blob/9165972991c6d2a67df001f363c8028256c2ca44/README.md) and the unchanged [simulator and fictional data](sim/README.md).

## Run it

Use Node.js 18.20 or newer and an Anthropic API key from your own account.

```bash
npm install
cp .env.example .env
# Set ANTHROPIC_API_KEY in .env
npm start
```

In a second terminal:

```bash
node sim/sim.mjs --target http://localhost:3000/webhooks
```

The default model is Claude Sonnet 4.6. Set `PHARMACY_LLM_MODEL` to use another model that supports Anthropic structured outputs. Keep the key in your environment or local `.env`. The simulator writes `out/run-log.jsonl` and `out/deliveries.jsonl`. Restart the app before replaying an identical fixture because an identical start can also be a webhook redelivery.

## How it works

I chose TypeScript and Node's built-in HTTP server because the simulator needs one endpoint and delivers events one at a time. The small stack keeps the extraction, dispatch rules, and outbound calls easy to test in isolation.

1. **Read the email.** Claude proposes structured changes. The service checks the sender against the simulator config, then validates the target, drug, exact dose, applicable dates and routing scope. Pharmacy contacts can update their own fulfillment facts. Ops can prefer or exclude a pharmacy for a stated scope. An Ops preference cannot grant fulfillment eligibility.
2. **Apply changes on the simulated clock.** The order or email timestamp drives the clock. Daily capacity resets at US Eastern midnight. Newer applicable facts override older ones, and an expired override exposes the previous applicable fact. For day-only wording, “until Wednesday” ends at the start of Wednesday. “The rest of the week” ends at the start of Monday. For supported midnight windows the code resolves the bounds from the Eastern receipt date and checks them against the model output.
3. **Pick an eligible destination.** Check that the pharmacy is open, serves the state, has the exact dose and has capacity. Apply Ops exclusions and then eligible preferences. If preferences overlap, the narrower one wins, with the more recent instruction breaking equal-scope ties. Otherwise use shipping time, then price, then pharmacy ID as a stable tie-breaker. Use `MANUAL` when no candidate remains.
4. **Record the outcome.** A repeated webhook or already-sent order does not consume capacity again. If the pharmacy API's response is uncertain, retain the reservation and only retry the same destination while it is still eligible on the same Eastern day. A rejected email goes on Sam's list. A closure that can be verified independently still takes effect. If extraction is unavailable, hold that pharmacy, or all pharmacies for an unreadable Ops email, for the rest of that replay.

## Verification and limits

`npm test` needs no API key. It runs the unchanged Week A simulator against the service with a local test double for Claude. All **52 deliveries** were acknowledged and all **38 orders** matched independently specified destinations, including five sent to `MANUAL`. Two invalid emails went to Sam's list. Additional tests cover Eastern midnight and DST, stock corrections, overbroad Ops rules, delivery retries, and a model outage.

The hosted Claude model and the evaluator's unseen week are untested in this rebuild. Source checks cover common language and time patterns. Complex scopes or ambiguous notices can be sent for review, and some less common facts still depend on the quality of the extraction. A run stores routing state and deduplication records in memory. I stopped after the core and the regression tests.

Before production I would authenticate the webhook and sender identities, persist accepted events, rule changes and dispatch reservations transactionally, and provide an operator workflow for review and reconciling an uncertain pharmacy API result. I would also measure the hosted model's extraction quality on labeled, representative mail before trusting new patterns.

## AI use

I used Codex and its agents to implement, test, and review the rebuild. The first webhook draft retried an uncertain send against the original reservation. Review showed that the pharmacy might have closed since that attempt. I added an eligibility check before redelivery and a regression that verifies no second pharmacy request is made after a closure.
