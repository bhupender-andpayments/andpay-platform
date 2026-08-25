# Postman collection

`collection.json` is GENERATED from the edge controllers. Never edit it by hand;
the next regeneration overwrites the whole file.

```bash
pnpm postman           # regenerate collection.json, and print what changed
pnpm postman:check     # exit 1 if collection.json has drifted from the code
pnpm postman:diff      # diff collection.json against the CLOUD copy (read only)
```

## When to regenerate

Whenever a route on any `apps/*/src/**/*.controller.ts` is added, removed, or
changes its body, headers, or auth. `pnpm postman:check` is the mechanical
answer to "did I forget"; it is deliberately NOT wired into `pnpm test` or CI,
so a route change never fails an unrelated run. To opt in later, one line in
`.github/workflows/ci.yml` after the `pnpm typecheck` step does it:

```yaml
      - run: pnpm postman:check
```

## How the generator works, and what it assumes

`build-collection.mjs` parses the controllers as text. There is no OpenAPI spec
in this repo, the body types are plain TS interfaces with no `class-validator`
decorators, and no route metadata survives to runtime, so static parsing is the
only source of truth available.

It leans on five properties of this codebase, each of which would otherwise be
a silent failure:

1. Only `@Get` and `@Post` are used.
2. Route decorators are single-quoted single-line literals, or take no argument
   (the four probe routes).
3. There is no `setGlobalPrefix` and no versioning, so the served path is
   exactly the controller base plus the method path. `/ops` comes only from
   `@Controller('ops')`.
4. Every `@Body()` type is an interface declared in the same file, an inline
   object type, or `unknown`.
5. `Idempotency-Key` is required exactly when the handler declares a
   `@Headers('idempotency-key')` param, which is the only way the value is ever
   obtained.

Two guards keep an unhandled form from shipping a short collection: the
generator refuses to write when the count of route decorators it found does not
equal the number of requests it emitted, and `test/postman-collection.test.ts`
asserts the same equality on every gate run alongside the comment-stripping and
guard-detection cases.

Comments are stripped before any decorator matching, because the controllers
discuss their own decorators in prose (one file says "there is no `@Body()`",
another carries a commented-out `@Controller`).

## Base URLs

One variable per edge, since the five run on different ports:

| Variable         | Default                 | Notes                                          |
| ---------------- | ----------------------- | ---------------------------------------------- |
| `authBase`       | `http://localhost:3000` |                                                |
| `opsBase`        | `http://localhost:3001` |                                                |
| `vendorBase`     | `http://localhost:3002` | The demo harness uses 3002, vendor-portal 3010. |
| `vendorAuthBase` | `http://localhost:3011` |                                                |
| `tenantBase`     | `http://localhost:3000` | No dev port is assigned; collides with auth.    |

Set `bearerToken` from a `POST /session/login` response (auth edge for
operators, vendor auth edge for vendor operators). The collection applies bearer
auth at the top level; public routes opt out individually.

## The cloud copy

`sync.mjs` talks to Rahul's cloud collection. It reads `POSTMAN_API_KEY` from
the environment and refuses to take it as an argument, because argv lands in
shell history and in the process list.

```bash
node postman/sync.mjs              # diff local against cloud
node postman/sync.mjs --push --yes # overwrite the cloud copy
```

**A push is destructive.** The Postman API has no merge: `PUT` replaces the
whole collection and discards anything added by hand in the Postman UI. The
diff names those requests under "IN THE CLOUD, NOT IN THE CODE" before you push,
and both `--push` and `--yes` are required. There is deliberately no
`pnpm postman:push` script.
