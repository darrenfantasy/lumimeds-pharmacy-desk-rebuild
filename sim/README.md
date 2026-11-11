# The simulator

`sim.mjs` replays a week at LumiMeds against your app. Pharmacy emails and new orders arrive as
webhooks, mixed together through the day, in time order. Your app routes each order by calling our
pharmacy API.

It needs **Node 18 or newer** and nothing else: no install, no dependencies.

Every pharmacy, person, address, order and email in the week files is made up.

```bash
node sim/sim.mjs --target http://localhost:3000/webhooks    # the whole week
node sim/sim.mjs --target http://localhost:3000/webhooks --ping    # quick check: 3 events only
```

Start with `--ping`. If you see three lines ending in `→ 200` and `no problems`, you're wired up.

## Your app

- **TypeScript, any framework.** We've replayed the full week through each of these: Express 5,
  Fastify 5, Hono 4, NestJS 12, Next.js 16 (route handler, `next dev` and `next start`), Elysia,
  `Bun.serve`, and plain `node:http` (run with `tsx`, and with Node's own `--experimental-strip-types`).
  If you use Node's own TypeScript support, write imports with the `.ts` extension.
- **One endpoint** that accepts `POST` with a JSON body. Every event goes to the same URL, and the
  `type` field says what it is. Use any path you like and pass it as `--target`.
- **Keep state between requests.** Keeping it in memory is fine. Run it as a normal server
  (`next dev`/`next start` work, but serverless hosting doesn't, because it forgets state between requests).

## Events

Every event has an `event_id`, a `type` and an `occurred_at`. The same values also arrive as the headers `x-event-id` and `x-sim-time`.

```jsonc
// 1. Always first. Reset your state when you receive it.
{ "event_id": "evt_000", "type": "simulation.started", "occurred_at": "2026-11-09T06:00:00-05:00",
  "pharmacyApi": "http://localhost:4000",
  "config": {
    "catalogue": { "semaglutide": ["0.25mg", "…"], "tirzepatide": ["2.5mg", "…"] },  // the doses that exist
    "lumimedsOps": ["sam@lumimeds.example", "…"],                                    // our ops team
    "pharmacies": [
      { "id": "TANDREL", "name": "Tandrel Rx", "contacts": ["jen@tandrel.example", "…"],
        "open": true, "shipsInDays": 1, "dailyCapacity": 4,                // orders it can take per day
        "price": { "semaglutide": 140, "tirzepatide": 210 },               // what we pay per order, in USD
        "blockedStates": ["FL", "GA", "NJ", "AK"],                         // states it can't ship to
        "stock": { "semaglutide": ["0.25mg", "…"], "tirzepatide": ["2.5mg", "…"] } }
      // … four more pharmacies
    ] } }

// 2. A pharmacy (or our ops team) emails Sam.
{ "event_id": "evt_031", "type": "email", "occurred_at": "2026-11-10T14:20:00-05:00",
  "email": { "from": "orders@example-pharmacy.example", "subject": "Friday", "body": "Hi Sam, quick one: we're closed on Friday for a stock count." } }

// 3. A patient's order was approved and needs a pharmacy.
{ "event_id": "evt_032", "type": "order", "occurred_at": "2026-11-10T14:35:00-05:00",
  "order": { "order_id": "ORD-2042", "state": "OH", "medication": "semaglutide", "dose": "1mg" } }

// (Illustrations only: the real events are in the week file.)
```

## How events are delivered

1. **One at a time, in time order.** The simulator sends the next event when your app replies to
   the current one, or after 30 seconds (`--timeout`) if it doesn't.
2. **Any 2xx reply counts as success**: 200, 201, 202 or 204. The reply body is ignored.
3. **At least once.** An event can be delivered more than once. A redelivery is an exact copy, with
   the same `event_id`.
4. **If your app can't be reached**, the simulator keeps retrying the same event for 15 seconds
   (`--wait`) before giving up.
5. **At the end**, it waits up to 60 seconds (`--drain`) for orders that haven't been sent yet.

## Time

**"Now" is the event's `occurred_at`. Never use the computer's clock** (`Date.now()`, `new Date()`).
The whole week replays in a minute or two. All times are US Eastern, with the offset written out.
There's no "a new day has started" event: only emails and orders.

## The pharmacy API

Send each order to a pharmacy, or to `MANUAL`:

```
POST {pharmacyApi}/pharmacy-orders
{ "order_id": "ORD-2042", "pharmacy": "VELMORA", "reason": "optional, for humans" }
```

`pharmacy` is a pharmacy id from the config, or `"MANUAL"` to hand the order to a person.

| Reply | Meaning |
|---|---|
| `201` | Sent. **Final**: a sent order can't be changed or re-sent. |
| `409` | That order was already sent. |
| `400` | The body isn't JSON, or `order_id` / `pharmacy` is missing. |
| `404` | Wrong path, or an `order_id` that isn't in this week. |

## What you get back

- **A live line per event**: its time, what it was, your reply, how long it took, and which pharmacy you sent the order to.
- **`out/run-log.jsonl`**: every order you sent. This is what we score.
- **`out/deliveries.jsonl`**: one line per event, with your reply status, the time it took and any error.
- **The exit code**: `0` if every event was delivered and every order was sent, `1` if there were problems. Problems are listed at the end.
  A clean exit means everything arrived, not that every order went to the right place.

## Options

| Option | Default | |
|---|---|---|
| `--target` | `http://localhost:3000/webhooks` | Your webhook URL |
| `--week` | `sim/week-a.jsonl` | Which week to replay |
| `--ping` | off | Send only the start event, one email and one order |
| `--timeout` | `30000` | Milliseconds to wait for your reply |
| `--wait` | `15` | Seconds to keep retrying an event while your app can't be reached |
| `--drain` | `60` | Seconds to wait at the end for orders that haven't been sent yet |
| `--pharmacy-port` | `4000` | Port for the pharmacy API (the URL arrives in `pharmacyApi`) |
| `--log`, `--deliveries` | `out/…` | Where to write the two logs |
| `--quiet` | off | No per-event lines |

## When something goes wrong

| Message | Likely cause |
|---|---|
| `can't reach your app at …` | Your app isn't running, or `--target` has the wrong port or path |
| `can't start the pharmacy API on port 4000` | Another program is using the port. Use `--pharmacy-port 4100` |
| `your app replied HTTP 4xx/5xx` | Your handler threw, or your framework didn't parse the JSON body |
| `no reply within 30000 ms` | Your handler hung or is too slow. The simulator moves on without it |
| `ORD-… was never sent to a pharmacy (or MANUAL)` | `/pharmacy-orders` was never called for that order, at least not within `--drain` seconds of the last event |
| `ORD-… was sent to the pharmacy API more than once` | The same order was sent again (the second send was refused with `409`) |
| `order(s) were sent after your app had replied to them` | Information, not an error |
