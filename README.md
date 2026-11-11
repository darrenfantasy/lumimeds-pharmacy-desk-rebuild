# LumiMeds take-home: run the pharmacy desk for a week

> **Everything in this repo is made up.** The pharmacies, people, email addresses, orders and emails
> are fictional. They were invented for this exercise and aren't LumiMeds' real systems or data.
> Any resemblance to a real business or person is coincidence.

**Visual guide:** [pharmacy-desk.buxmann.dev](https://pharmacy-desk.buxmann.dev) shows how the exercise
runs. This README has the details.

|  |  |
|---|---|
| ⏱️ **Two hours, then 15 minutes** | Two hours to build, then up to 15 minutes to write your README. Both are hard stops. How you split the building time is up to you. |
| 🧰 **Any TypeScript stack** | Use whatever you're comfortable with, set it up yourself, and tell us why you chose it. |
| 🤖 **AI welcome** | Use it as much as you like. You're responsible for what ships. |
| 🛟 **Safe first** | An order sent to a pharmacy that can't fill it outweighs everything else. |

## The story

LumiMeds is a telehealth company. When a doctor approves a patient's treatment, the order goes to
one of our partner pharmacies, which makes the medication and ships it to the patient.

Every pharmacy is different. Each one ships to some states and not others, stocks some doses and
not others, takes a certain number of days to ship, charges us its own price, and can only take so
many orders a day.

Those facts change all the time, and the changes arrive by email, from the pharmacies and from our
own ops team. Today, Sam on our operations team reads every email, keeps track of it all by hand,
and decides where each order goes. One mistake sends medication to a pharmacy that can't legally or
physically fill it.

**Your job: build the system that takes Sam's place.**

## 1 · How it runs

A simulator replays a week at LumiMeds against your app. Emails and new orders arrive as webhooks
throughout the day, in time order. Your app reads the emails and sends each order to a pharmacy
through our pharmacy API. What goes on inside your app is up to you.

The exact contract is in **[`sim/README.md`](sim/README.md)**. Read it before you start.

## 2 · One event at a time

The simulator sends events one at a time, in time order: the next one goes out when your app replies,
so a whole week replays in a minute or two. Like real webhooks, an event can be delivered more than
once. Use the time on each event as "now", never the computer's clock.

## 3 · Business goals, in priority order

Goals, not an algorithm. How you meet them is up to you.

1. **Safe.** Never send an order to a pharmacy that can't fill it: it can't ship to the patient's
   state, doesn't have that exact dose, is closed, or has no capacity left today.
2. **Follow LumiMeds ops instructions.** Our ops team's addresses are in `config.lumimedsOps`.
3. **Fastest delivery** for the patient.
4. **Then cheapest** for us.
5. **`MANUAL` only when no pharmacy can safely take the order.** A person will route it.

When goals conflict, decide what's right and explain it in your README.

**About the emails:** pharmacies can tell us about themselves, but only LumiMeds ops decides where
orders go. A change applies from when it says it does, until when it says it does. If you're not
sure about an email, put it on a list for Sam with the reason, and keep every order safe in the meantime.

## 4 · What to build

There's more here than fits in two hours, on purpose. We'd rather see a core that's right in every
case than many features done halfway.

### The core: what has to be true

- **It runs the whole week:** every event is handled, and every order is sent to a pharmacy or to `MANUAL`.
- **An LLM reads the emails.** How you use it is up to you.
- **No email that's wrong or not allowed changes where orders go.** Anything unclear goes on Sam's list.
- **Every order follows the goals**, with what's true at the moment it arrives.
- **You can show it works**, the way you'd ship it at work.

When the core works, **commit with the message `core done`**.

### Bonuses (if there's time: pick, don't spread)

| | Bonus | Done means |
|---|---|---|
| 🟢 | **Cheaper and better** | Label a handful of emails, measure how well your app reads them, and compare models (including a cheaper one) and prompts on accuracy, cost and speed. End with a recommendation. |
| 🟢 | **Draft replies** | For everything on Sam's list, draft a reply to the sender for Sam to review and send. |
| 🟡 | **Sam's live desk** | A page that updates as the week replays: each pharmacy, how many orders it's had today, and Sam's list. Sam can approve a held change, and it applies from that moment. |
| 🟡 | **Explain any decision** | Answer, after the fact: "Why did ORD-2011 go where it went?" and "What did we believe about Velmora on Tuesday at 10:00?" |
| 🔴 | **Ask the desk** | Sam asks in plain English, like "Who can take a NY tirzepatide 7.5mg order right now?". An LLM answers from your app's actual state, says when it doesn't know, and never changes anything itself. |
| 🔴 | **Survive a restart** | Stop your app in the middle of the week and start it again. The week still completes, with nothing lost and nothing done twice. |

A bonus only counts if the core works. One done properly beats three half-done.

## 5 · Get started

```bash
git clone https://github.com/Lumimeds/take-home-pharmacy-desk && cd take-home-pharmacy-desk
# set up your TypeScript app with a POST endpoint, and start it on :3000
node sim/sim.mjs --target http://localhost:3000/webhooks --ping    # three events, to check your wiring
node sim/sim.mjs --target http://localhost:3000/webhooks           # the whole week
```

The simulator needs Node 18 or newer and nothing else. **API key:** use your own, for any LLM
provider you like. Put it in `.env` and never commit it. A week is only about ten emails, so it costs very little.

## 6 · How we evaluate

- **We replay a week you haven't seen:** the same kinds of emails and orders, different details,
  three times, because AI answers vary.
- **Safety first.** One unsafe order outweighs everything else.
- **Then quality:** following ops instructions, using `MANUAL` only when needed, fast and cheap delivery.
- **Your judgment:** what you chose to do and not do, and why.

**Quality over quantity.** Stop building when the two hours are up, even mid-feature. Then take up to
15 minutes for your README, and tell us where you stopped.

## What to send back

A link to your Git repository, with your code (runnable with `npm install && npm start`, or tell us
what else it needs) and a `README` covering:

- what you built and how to run it
- which stack you chose, and why
- why you're confident it works
- how you decide where an order goes, and what you do when the goals conflict
- what you chose not to do, and why
- which rules you found ambiguous, and what you decided
- anything you know is wrong or untested
- what you'd change before running this in production
- how you used AI, and one place where you didn't accept what it gave you

We may follow up with some questions about your solution.
