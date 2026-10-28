Read AGENTS.md first: it is the authoritative description of this repo's stack, layout, build, test and release.

Never miss:
- `git pull --rebase --autostash` before work and before every commit; stage explicit paths.
- The version lives in meta.json only. Bump it there to release; CI does the rest.
- Nothing is loaded from a CDN: Butterchurn comes from node_modules and is embedded in the DLL.
- Run `npm test` and `dotnet test` before every commit.
