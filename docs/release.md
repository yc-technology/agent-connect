# Release process

We use [`@changesets/cli`](https://github.com/changesets/changesets) for
version bumps and npm publishes. `pnpm publish` (or `changeset publish`)
rewrites `workspace:*` in package.json to a concrete version at pack time;
plain `npm publish` does NOT and will ship broken tarballs. Don't run
`npm publish` directly on any package in this repo — 0.3.1 / 0.3.2 / 0.3.3
shipped that way and had to be deprecated.

## Day-to-day: declare a release-worthy change

When you land a change that should ship in the next release, add a
changeset:

```sh
pnpm changeset
```

The interactive prompt:
1. Pick the packages affected (multi-select with space).
2. Pick the bump level (patch / minor / major).
3. Write a one-line summary; it goes into the auto-generated tag /
   commit message but the human-facing changelog lives in
   `CHANGELOG.md` / `CHANGELOG_CN.md` (we set
   `"changelog": false` in `.changeset/config.json` so changesets
   doesn't double-manage it).

This writes a `.changeset/<slug>.md`; commit it with the rest of the
change. PRs can include 0..N changesets; they accumulate until the next
release.

## Releasing

```sh
# 1. Update versions in package.json + delete consumed changeset files.
#    `bot` + `cli` are `fixed` together — bumping one always bumps the other.
pnpm changeset version

# 2. Hand-write the matching CHANGELOG.md / CHANGELOG_CN.md entry
#    (keep style consistent with prior releases — emoji headers + prose).

# 3. Commit + tag.
git add -A
git commit -m "release(X.Y.Z): <short summary>"
git push origin main

# 4. Publish. Rewrites `workspace:*` → concrete versions, runs npm publish
#    under the hood, creates per-package git tags (e.g. `@yc-tech/agent-connect-bot@X.Y.Z`).
pnpm changeset publish

# 5. Push the per-package tags (changeset publish creates them locally).
git push origin --tags
```

## Verifying a release

Always confirm the published tarball has the dep rewrite:

```sh
mkdir -p /tmp/verify && cd /tmp/verify && rm -f *.tgz
npm pack @yc-tech/agent-connect-cli@<version>
tar -xOf yc-tech-agent-connect-cli-<version>.tgz package/package.json \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('dependencies',{}))"
```

The output should show every workspace dep pinned to an exact version, e.g.

```json
{
  "@yc-tech/agent-connect-bot": "0.3.4",
  "undici": "^8.3.0"
}
```

If you see `"workspace:*"` anywhere, the release is broken — deprecate it
and ship a fixed version (see "Deprecating a broken release" below).

## Deprecating a broken release

```sh
npm deprecate @yc-tech/agent-connect-cli@"0.3.1 - 0.3.3" \
  "this version has workspace:* in deps and cannot be installed; upgrade to ^0.3.4"
# repeat for any other affected package
```

The CHANGELOG should also document the breakage and the migration path in
the replacement release's section.

## Config reference: `.changeset/config.json`

- `changelog: false` — CHANGELOG.md is hand-written. If you switch to
  auto-generation, point this at `@changesets/cli/changelog` or a custom
  generator.
- `fixed: [["@yc-tech/agent-connect-bot", "@yc-tech/agent-connect-cli"]]`
  — cli imports bot internals (`@yc-tech/agent-connect-bot/hookClient`
  etc.), so they must always ship at the same version. `fixed` enforces
  lockstep bumps.
- `ignore: ["@yc-tech/agent-connect-web"]` — the React console isn't
  released to npm; it's bundled into apps/bot's tarball as static
  assets.
- `updateInternalDependencies: patch` — when a workspace dep gets any
  bump, its dependents auto-bump at patch level. (This is mostly cosmetic
  since `fixed` already handles bot↔cli.)
- `access: public` — all `@yc-tech/*` scoped packages publish public.

## Why not `npm publish`?

`workspace:*` is pnpm's protocol for "depend on the workspace sibling at
whatever version it's at right now". npm doesn't recognize it. `pnpm
publish` (and `changeset publish`, which calls into pnpm) replace
`workspace:*` with the resolved version at pack time, so the tarball
contains `"@yc-tech/agent-connect-bot": "0.3.4"` instead. `npm publish`
ships the literal string and breaks installs at the registry — see the
0.3.1–0.3.3 incident.
