# Upstream ledger

remotea started as a copy of [wmux](https://github.com/amirlehmam/wmux) at `29c1d52` (wmux v2.45.0, 2026-10-27). It no longer merges from wmux. Every wmux commit made after that point has one ruling below. Fixes worth having are copied over one at a time with `git cherry-pick -x`, so each ported commit names its source.

This ledger covers `29c1d52..f289014`: 175 commits, the last on 2026-11-18. Later wmux fixes that remotea picks up by hand get a row under [Later fixes](#later-fixes).

## Rulings

Every ruling follows one of these rules:

- **ported**: a `fix` commit. It is copied into remotea before any removal or rename in the cleanup.
- **skipped**: a `feat` commit, unless the owner flags it below; a fix that only touches the browser panel or the legacy orchestrator, both of which remotea is removing; or a fix for an upstream feature remotea doesn't have.
- **not applicable**: release and Scoop chores, merge commits, documentation, and regenerated `resources/cli` builds.

A fix that also touches the browser keeps only its non-browser part. Hunks for languages remotea is removing are dropped; English, Czech, French and Traditional Chinese stay.

Totals: 49 ported, 44 skipped, 82 not applicable.

The **ported as** column names the remotea commit. Each port's message ends with `(cherry picked from commit …)` and, where the port differs from upstream, a "remotea port notes" list saying what was left out or resolved by hand.

## Judgment calls

These rows needed a call the rules don't settle. The owner confirmed all four on 2026-11-18.

- **1c7ebb0** "complete panel docking and browser control handling" is typed as a fix but changes 26 files and adds panel docking (a docked explorer) and wheel zoom. Ruled ported without its browser parts. Two later fixes, ebab909 and 71d89ba, build on its wheel zoom. At port time only the wheel zoom was taken: the docking conflicts with remotea's refreshed explorer and sidebar, and the owner asked that UI changes be ported only where they fit.
- **4a529c7** fixes unreachable overflowing tabs and also adds an immersive mode to the phone console and workspace edge controls. Ruled ported as a whole, without the removed languages.
- **b283d0b** is a `chore` that deletes a second copy of the agent instructions (`resources/claude-instructions/claude-instructions.md`). remotea has the same copy and a test that keeps it identical to the real file; nothing else reads it. Ruled ported, and the port also drops that test assertion.
- **Fixes for features remotea doesn't have** are ruled skipped. This rule isn't in the plan: a fix to pi session restore, terminal history, the WSL hooks installer or pane lock can't apply without the feature it fixes. It decides 13 rows. Flagging one of those features brings its fixes back.

## Features

Features are skipped unless the owner flags them. In the 2026-11-18 review the owner chose six to port: e95e883, a661ab7, 017cc13, 72d246b, fa97b16 and 1266792. The features inside fix 4a529c7 (last row) come with that fix.

| sha | date | feature | note |
|---|---|---|---|
| `e95e883` | 2026-10-27 | feat(paste): downscale and encode pasted images off the main thread (#381) | **Ported.** |
| `fde088e` | 2026-10-27 | feat(resume): restore pi sessions per pane with pi --session (#382) | Brings fixes 2897a2a and ea146fc with it. |
| `5147b68` | 2026-10-27 | feat(markdown): math, mermaid diagrams and local images in the markdown pane (#380) |  |
| `fd01877` | 2026-10-27 | feat(titlebar): group the titlebar buttons and move help and devtools to Settings | remotea regrouped its own titlebar (e7014d4). |
| `ed68e78` | 2026-10-27 | feat(agent-context): ship the Claude Code guidance as a skill (#386) | Revisit when the agent instructions are rewritten (U15): the skill would be installed under the old name. |
| `97050e2` | 2026-10-29 | feat(settings): add integrated shortcut unbind controls (#393) |  |
| `32c9817` | 2026-10-29 | feat(pi): scope instructions to wmux with an on-demand reference (#394) |  |
| `b43247f` | 2026-10-29 | feat(terminal-history): add safe history codec and replay | Terminal history is 6,700 lines, and remotea's server already keeps its terminals alive across app restarts. One of the eight-commit terminal history series (b43247f to 915e868, then 111d7c6). Porting it would also bring fixes 4ec6288, 2bc532b, 4233510, b7e7cc0, f60e85a and a160ebb. |
| `d4decd2` | 2026-10-29 | feat(terminal-history): add atomic storage and durable consent | Part of the terminal history series; see b43247f. |
| `23eebf9` | 2026-10-29 | feat(terminal-history): authorize IPC and publish automatic references | Part of the terminal history series; see b43247f. |
| `887ce6a` | 2026-10-29 | feat(terminal-history): restore fresh terminals with safe lifecycle handoffs | Part of the terminal history series; see b43247f. |
| `507b15b` | 2026-10-29 | feat(terminal-history): checkpoint dirty buffers and correlate final flush | Part of the terminal history series; see b43247f. |
| `c2ea845` | 2026-10-29 | feat(terminal-history): clean closed surfaces and preserve upgrade history | Part of the terminal history series; see b43247f. |
| `915e868` | 2026-10-29 | feat(terminal-history): expose opt-in controls and failure feedback | Part of the terminal history series; see b43247f. |
| `9bc90e1` | 2026-10-31 | feat: refine desktop workspace frames and navigation | wmux's own design pass; remotea refreshed its chrome its own way. |
| `017cc13` | 2026-11-01 | feat: add surface refresh and pane zoom controls | **Ported.** |
| `e8997e5` | 2026-11-03 | feat(browser): label tabs with the page title (#423) | Browser panel; can't be ported, the panel is being removed. |
| `a661ab7` | 2026-11-03 | Inherit the active terminal’s shell for splits and new tabs (#422) | **Ported.** Has no type prefix but adds behavior. |
| `72d246b` | 2026-11-04 | feat(terminal): add a Clear terminal buffer action (#434) | **Ported.** |
| `3402b2e` | 2026-11-04 | feat(wsl): install Claude Code hooks into running WSL distros (#428) | Brings fixes ff2179c, a4a994e, 0d516fb and 67826e0 with it. |
| `dd21604` | 2026-11-04 | feat: replace pane split dropdown with direct buttons (#436) | Split down is already in the split menu and has a shortcut; the tab bar stays lean. |
| `a3b4450` | 2026-11-04 | feat(titlebar): add browser panel toggle (#437) | Browser panel; can't be ported. |
| `bbe4fb3` | 2026-11-04 | feat(diagnostics): count live terminals and WebGL renderers in shipped builds (#421) |  |
| `cd1e4f7` | 2026-11-06 | feat(titlebar): ChatGPT Web dictation, opt-in (#438) |  |
| `5a9cf39` | 2026-11-07 | feat: browser link menu and hover URL (#439), close to tray (#442) | The browser link menu can't be ported; close to tray could be ported on its own. |
| `fa97b16` | 2026-11-10 | feat(tabs): resume the just-closed tab's agent session on Ctrl+Shift+T (#447) | **Ported.** |
| `73b7980` | 2026-11-13 | feat(diff): wrap long lines toggle in the Diff tab and Git view (#450) |  |
| `1266792` | 2026-11-15 | feat(panes): show no focused pane in an unfocused window (#459) | **Ported.** |
| `427db79` | 2026-11-15 | feat(panes): lock a pane against spawned agents and moved tabs (#454) | Brings fix 62724b0 with it. |
| `3ee1c06` | 2026-11-17 | feat(sidebar): add set-indicator / clear-indicator for a workspace pill (#461) |  |
| `ad75bd9` | 2026-11-18 | feat(agent-browser): show and control the agent browser page in wmux (#455) | Browser panel; can't be ported. |
| `4a529c7` | 2026-10-31 | The phone console's immersive mode and workspace edge controls, inside a fix commit | Ported with that fix. |

## All commits

Oldest first.

| sha | date | type | subject | ruling | reason | ported as |
|---|---|---|---|---|---|---|
| `955087f` | 2026-10-27 | fix | fix(panes): focus the pane a split just created | ported | Fix. | `4d3050c` |
| `c171bfb` | 2026-10-27 | merge | Merge pull request #383 from alejandronava562/fix/focus-new-pane | not applicable | Merge commit; its commits have their own rows. |  |
| `f498f3f` | 2026-10-27 | fix | fix(panes): move focus only when the split happened | ported | Fix. | `b4f3655` |
| `18669ce` | 2026-10-27 | chore | chore(release): bump to 2.45.1 | not applicable | Release version bump. |  |
| `17972a4` | 2026-10-27 | chore | chore(scoop): bucket manifest for 2.45.1 | not applicable | Scoop manifest. |  |
| `26dd221` | 2026-10-27 | fix | fix(browser): keep a hidden browser pane painting while an agent drives it | skipped | Browser only: keeps a hidden browser pane painting while an agent drives it. |  |
| `e95e883` | 2026-10-27 | feat | feat(paste): downscale and encode pasted images off the main thread (#381) | ported | Feature the owner chose to port in the ledger review (2026-11-18). Pasting a large image no longer freezes the window. | `43b7906` |
| `fde088e` | 2026-10-27 | feat | feat(resume): restore pi sessions per pane with pi --session (#382) | skipped | Feature. Port only if flagged. |  |
| `5147b68` | 2026-10-27 | feat | feat(markdown): math, mermaid diagrams and local images in the markdown pane (#380) | skipped | Feature. Port only if flagged. |  |
| `9d351f2` | 2026-10-27 | fix | fix(renderer): release state that closed surfaces and unread notifications kept (#385) | ported | Fix. | `57039ef` |
| `ef03d10` | 2026-10-27 | fix | fix(markdown): drop network-path image sources from raw HTML | ported | Fix. | `7b1bb55` |
| `ff0144b` | 2026-10-27 | merge | Merge pull request #384 from clemrdh/fix/render-hidden-browser-pane | not applicable | Merge commit; its commits have their own rows. |  |
| `0bacae7` | 2026-10-27 | fix | fix(browser): bound the keep-rendering grant so a hung renderer cannot hang a verb | skipped | Browser only: bounds the keep-rendering grant from 26dd221. |  |
| `0eef2d5` | 2026-10-27 | merge | Merge branch 'feat/381-fast-image-paste' | not applicable | Merge commit; its commits have their own rows. |  |
| `7c1696b` | 2026-10-27 | merge | Merge branch 'fix/385-renderer-retention' | not applicable | Merge commit; its commits have their own rows. |  |
| `489a7a9` | 2026-10-27 | merge | Merge branch 'feat/382-pi-resume' | not applicable | Merge commit; its commits have their own rows. |  |
| `38f08cc` | 2026-10-27 | merge | Merge branch 'feat/380-markdown-math-mermaid-images' | not applicable | Merge commit; its commits have their own rows. |  |
| `beb5484` | 2026-10-27 | chore | chore(deps): lock katex and mermaid, bump dompurify 3.4.17 and js-yaml 4.3.2 | not applicable | Already in remotea: DOMPurify 3.4.17 and js-yaml 4.3.2. The katex and mermaid locks belong to the markdown math feature (5147b68). |  |
| `5e17db6` | 2026-10-27 | fix | fix(markdown): register the network-path hook only where DOMPurify has a DOM | ported | Fix. | `453f81d` |
| `475042f` | 2026-10-27 | chore | chore(release): bump to 2.46.0 | not applicable | Release version bump. |  |
| `eb4ed07` | 2026-10-27 | chore | chore(scoop): bucket manifest for 2.46.0 | not applicable | Scoop manifest. |  |
| `fd01877` | 2026-10-27 | feat | feat(titlebar): group the titlebar buttons and move help and devtools to Settings | skipped | Feature. remotea regrouped its own titlebar (e7014d4). |  |
| `6ccd495` | 2026-10-27 | chore | chore(release): bump to 2.47.0 | not applicable | Release version bump. |  |
| `7ec00c0` | 2026-10-27 | chore | chore(scoop): bucket manifest for 2.47.0 | not applicable | Scoop manifest. |  |
| `ed68e78` | 2026-10-27 | feat | feat(agent-context): ship the Claude Code guidance as a skill (#386) | skipped | Feature. Revisit when the agent instructions are rewritten (U15): the skill would be installed under the old name. |  |
| `4c4e940` | 2026-10-27 | chore | chore(release): bump to 2.48.0 | not applicable | Release version bump. |  |
| `646268c` | 2026-10-27 | chore | chore(scoop): bucket manifest for 2.48.0 | not applicable | Scoop manifest. |  |
| `c26bc22` | 2026-10-28 | fix | fix(browser): clicking into a page focuses its pane (#388) | skipped | Browser only: focus when clicking into a page. |  |
| `40219ce` | 2026-10-28 | docs | docs: replace the manual release procedure with a wmux-release skill (#389) | not applicable | Documentation. |  |
| `20ea34b` | 2026-10-28 | docs | docs: move the main-process table's notes into each module (#390) | not applicable | Documentation. |  |
| `8915ab9` | 2026-10-28 | chore | chore(release): bump to 2.48.1 | not applicable | Release version bump. |  |
| `546bd4b` | 2026-10-28 | chore | chore(scoop): bucket manifest for 2.48.1 | not applicable | Scoop manifest. |  |
| `d848a58` | 2026-10-29 | docs | docs: cover re-runs, signing and CLI packaging in the release skill (#391) | not applicable | Documentation. |  |
| `200c788` | 2026-10-29 | fix | fix(notifications): silence alerts for the focused terminal (#392) | ported | Fix. | `d24359b` |
| `97050e2` | 2026-10-29 | feat | feat(settings): add integrated shortcut unbind controls (#393) | skipped | Feature. Port only if flagged. |  |
| `3157aac` | 2026-10-29 | fix | fix(notifications): keep a notify whose pane is gone (#392 follow-up) | ported | Fix. | `39871de` |
| `f458724` | 2026-10-29 | fix | fix(cli): give list-workspaces its workspace.list back (#398) | ported | Fix. | `4aa3a4e` |
| `09ec2d0` | 2026-10-29 | fix | fix(terminal): rebuild the WebGL renderer after a width change (#400) | ported | Fix. | `2cb7eec` |
| `32c9817` | 2026-10-29 | feat | feat(pi): scope instructions to wmux with an on-demand reference (#394) | skipped | Feature. Port only if flagged. |  |
| `2897a2a` | 2026-10-29 | fix | fix(pi): restore sessions inside WSL (#395) | skipped | Fixes pi session restore (fde088e), which remotea doesn't have. Ports with it if that feature is flagged. |  |
| `69d2b0c` | 2026-10-29 | fix | fix(wsl): restore reported pane working directories (#397) | ported | Fix. | `9ccb7d7` |
| `ea146fc` | 2026-10-29 | fix | fix(pi): refuse a backslash in a Linux session path (#395 follow-up) | skipped | Fixes pi session restore (fde088e), which remotea doesn't have. Ports with it if that feature is flagged. |  |
| `ae60da6` | 2026-10-29 | fix | fix(agent-state): clear a permission block once the agent moves past it (#399) | ported | Fix. | `eee7b31` |
| `b22f291` | 2026-10-29 | fix | fix(wsl): keep restored WSL panes starting after their folder moved (#397 follow-up) | ported | Fix. | `bd1e603` |
| `6bf42d5` | 2026-10-29 | chore | chore(release): bump to 2.49.0 | not applicable | Release version bump. |  |
| `b43247f` | 2026-10-29 | feat | feat(terminal-history): add safe history codec and replay | skipped | Feature. Terminal history is 6,700 lines, and remotea's server already keeps its terminals alive across app restarts. |  |
| `d4decd2` | 2026-10-29 | feat | feat(terminal-history): add atomic storage and durable consent | skipped | Feature. Port only if flagged. |  |
| `23eebf9` | 2026-10-29 | feat | feat(terminal-history): authorize IPC and publish automatic references | skipped | Feature. Port only if flagged. |  |
| `887ce6a` | 2026-10-29 | feat | feat(terminal-history): restore fresh terminals with safe lifecycle handoffs | skipped | Feature. Port only if flagged. |  |
| `507b15b` | 2026-10-29 | feat | feat(terminal-history): checkpoint dirty buffers and correlate final flush | skipped | Feature. Port only if flagged. |  |
| `a160ebb` | 2026-10-29 | test | test(terminal-history): follow named exit-handler wiring | skipped | Fixes terminal history (the `feat(terminal-history)` series), which remotea doesn't have. Ports with it if that feature is flagged. |  |
| `c2ea845` | 2026-10-29 | feat | feat(terminal-history): clean closed surfaces and preserve upgrade history | skipped | Feature. Port only if flagged. |  |
| `915e868` | 2026-10-29 | feat | feat(terminal-history): expose opt-in controls and failure feedback | skipped | Feature. Port only if flagged. |  |
| `f60e85a` | 2026-10-29 | refactor | refactor(terminal-history): remove redundant restore marker | skipped | Fixes terminal history (the `feat(terminal-history)` series), which remotea doesn't have. Ports with it if that feature is flagged. |  |
| `4ec6288` | 2026-10-29 | fix | fix(terminal-history): keep restored output visible above fresh prompts | skipped | Fixes terminal history (the `feat(terminal-history)` series), which remotea doesn't have. Ports with it if that feature is flagged. |  |
| `2bc532b` | 2026-10-29 | fix | fix(terminal-history): address branch audit findings | skipped | Fixes terminal history (the `feat(terminal-history)` series), which remotea doesn't have. Ports with it if that feature is flagged. |  |
| `4233510` | 2026-10-29 | fix | fix(terminal-history): shorten the settings description | skipped | Fixes terminal history (the `feat(terminal-history)` series), which remotea doesn't have. Ports with it if that feature is flagged. |  |
| `b7e7cc0` | 2026-10-29 | fix | fix(terminal-history): add spacing after the session divider | skipped | Fixes terminal history (the `feat(terminal-history)` series), which remotea doesn't have. Ports with it if that feature is flagged. |  |
| `677ec9d` | 2026-10-29 | chore | chore(scoop): bucket manifest for 2.49.0 | not applicable | Scoop manifest. |  |
| `88cc81a` | 2026-10-29 | fix | fix(opencode): capture loop sessions and keep TUI handles across restarts | ported | Fix. | `65c8c81` |
| `1f61ed9` | 2026-10-30 | docs | docs: move the renderer list's notes into each module | not applicable | Documentation. |  |
| `9d54540` | 2026-10-30 | docs | docs: move the prompt and preload notes out of AGENTS.md | not applicable | Documentation. |  |
| `fbd15f5` | 2026-10-30 | docs | docs: add the wmux-pipe-method skill and shorten the pipe section | not applicable | Documentation. |  |
| `54dad4d` | 2026-10-30 | docs | docs: add the wmux-agent-integration skill and collapse its table rows | not applicable | Documentation. |  |
| `af544b4` | 2026-10-30 | docs | docs: shorten the keep-alive and orchestrator sections of AGENTS.md | not applicable | Documentation. |  |
| `f035179` | 2026-10-31 | merge | fix: merge OpenCode session restoration improvements (#402) | not applicable | Merge commit; its commits have their own rows. |  |
| `0e48d12` | 2026-10-31 | merge | docs: move renderer notes into modules (#406) | not applicable | Merge commit; its commits have their own rows. |  |
| `9d65d5a` | 2026-10-31 | merge | docs: shorten prompt and preload guidance (#407) | not applicable | Merge commit; its commits have their own rows. |  |
| `916ce37` | 2026-10-31 | merge | docs: add pipe method skill (#408) | not applicable | Merge commit; its commits have their own rows. |  |
| `eedab53` | 2026-10-31 | merge | docs: add agent integration skill (#409) | not applicable | Merge commit; its commits have their own rows. |  |
| `6dea444` | 2026-10-31 | merge | docs: shorten terminal and orchestrator notes (#410) | not applicable | Merge commit; its commits have their own rows. |  |
| `111d7c6` | 2026-10-31 | merge | feat: preserve terminal output across restarts (#401) | not applicable | Merge commit; its commits have their own rows. |  |
| `4a529c7` | 2026-10-31 | fix | fix: make overflowing tabs reachable and add immersive phone and workspace edge controls | ported | The tab-overflow fix. Drop the hunks for languages remotea removes. The phone immersive mode and workspace edge controls it also adds are listed under features. | `aabeecb` |
| `7ebbabc` | 2026-10-31 | chore | chore(release): bump to 2.50.0 | not applicable | Release version bump. |  |
| `86b1cbe` | 2026-10-31 | chore | chore(scoop): bucket manifest for 2.50.0 | not applicable | Scoop manifest. |  |
| `9bc90e1` | 2026-10-31 | feat | feat: refine desktop workspace frames and navigation | skipped | Feature. wmux's own design pass; remotea refreshed its chrome its own way. |  |
| `cca5ada` | 2026-10-31 | chore | chore(release): bump to 2.51.0 | not applicable | Release version bump. |  |
| `df30c8e` | 2026-10-31 | chore | chore(scoop): bucket manifest for 2.51.0 | not applicable | Scoop manifest. |  |
| `475f228` | 2026-10-31 | docs | docs: rewrite README with current workflows and desktop screenshots | not applicable | Documentation. |  |
| `989fa80` | 2026-10-31 | docs | docs: show multi-agent workspace with browser and Git graph | not applicable | Documentation. |  |
| `86aed78` | 2026-10-31 | fix | fix(browser): stabilize reload, devtools focus, and app zoom | ported | Non-browser hunks only: app zoom (`zoom-factor.ts`). The reload and devtools parts are browser. | `4451e03` |
| `d6c1a4c` | 2026-10-31 | chore | chore(scoop): bucket manifest for 2.52.0 | not applicable | Scoop manifest. |  |
| `1c7ebb0` | 2026-10-31 | fix | fix: complete panel docking and browser control handling | ported | Wheel zoom only. Panel docking left out at port time: it is a UI feature that conflicts with remotea's refreshed explorer and sidebar, and it is tied to the browser panel and terminal history. | `41d7777` |
| `d036e74` | 2026-10-31 | chore | chore(release): bump to 2.53.0 | not applicable | Release version bump. |  |
| `ebab909` | 2026-10-31 | fix | fix(zoom): handle desktop wheel gestures only once | ported | Builds on the wheel zoom from 1c7ebb0; skipped if 1c7ebb0 is. | `6a250a5` |
| `e053547` | 2026-10-31 | chore | chore(scoop): bucket manifest for 2.53.0 | not applicable | Scoop manifest. |  |
| `b283d0b` | 2026-11-01 | chore | chore: remove stale Claude instructions | ported | Deletes a second copy of the agent instructions. remotea has it too, kept identical by the assertion at `tests/unit/agent-instructions.test.ts:75`; the port drops that assertion. | `b15c703` |
| `7e1f43a` | 2026-11-01 | docs | docs: simplify AGENTS guidance | not applicable | Documentation. |  |
| `f8381e9` | 2026-11-01 | fix | fix(sidebar): prevent unread badge overlap | ported | Fix. | `4856703` |
| `017cc13` | 2026-11-01 | feat | feat: add surface refresh and pane zoom controls | ported | Feature the owner chose to port in the ledger review (2026-11-18). Per-pane zoom and F5 refresh, needed by fix 71d89ba. Leave out the browser hunk. | `1f8d4a1` |
| `c8d387d` | 2026-11-01 | chore | chore(release): bump to 2.54.0 | not applicable | Release version bump. |  |
| `ede35f6` | 2026-11-01 | chore | chore(scoop): bucket manifest for 2.54.0 | not applicable | Scoop manifest. |  |
| `e500087` | 2026-11-03 | fix | fix: equalize spacing around the first pane tab (#426) | not applicable | Spacing for wmux's tab bar; remotea's refreshed tab bar sets its own height. The cherry-pick came up empty. |  |
| `5657964` | 2026-11-03 | fix | fix(terminal): preserve image overlay transparency on Windows (#424) | ported | Fix. | `8ed7d4a` |
| `2e001a7` | 2026-11-03 | fix | fix(terminal): track cwd from CMD OSC 9 reports (#429) | ported | Fix. | `0744e22` |
| `e8997e5` | 2026-11-03 | feat | feat(browser): label tabs with the page title (#423) | skipped | Feature. Port only if flagged. |  |
| `a661ab7` | 2026-11-03 | untyped | Inherit the active terminal’s shell for splits and new tabs (#422) | ported | Feature the owner chose to port in the ledger review (2026-11-18). New splits and tabs use the active terminal's shell. | `b325ab7` |
| `6535529` | 2026-11-03 | fix | fix(terminal): no opaque band behind dim or italic text on a see-through terminal (#425) | ported | Fix. | `2519390` |
| `71d89ba` | 2026-11-03 | fix | fix(zoom): zoom a terminal pane through its font, like Windows Terminal (#420) | ported | Builds on the wheel zoom from 1c7ebb0; skipped if 1c7ebb0 is. | `2b0d60a` |
| `d801062` | 2026-11-03 | fix | fix(shell-integration): check out shell scripts with LF (#428) | ported | Fix. | `766a101` |
| `3d47e6c` | 2026-11-03 | fix | fix(shell-integration): report cwd from Git Bash and WSL over the pipe (#427, #428) | ported | Leave out the `pane-browser-env.ts` hunk. | `c73a6d1` |
| `d0b2644` | 2026-11-03 | chore | chore(release): bump to 2.55.0 | not applicable | Release version bump. |  |
| `c4f3357` | 2026-11-03 | test | test: compare the Git Bash cwd report against the long-name path | ported | Test for 3d47e6c; ports with it. | `cd4b226` |
| `f9bfcac` | 2026-11-03 | chore | chore(scoop): bucket manifest for 2.55.0 | not applicable | Scoop manifest. |  |
| `9c33a21` | 2026-11-03 | fix | fix(instructions): keep the shared command reference agent-neutral (#430) | ported | Fix. | `2dd3f57` |
| `9969f1e` | 2026-11-03 | fix | fix(terminal): release a hidden terminal's WebGL context immediately (#421) | ported | Fix. | `412601f` |
| `835c2f8` | 2026-11-03 | chore | chore(release): bump to 2.55.1 | not applicable | Release version bump. |  |
| `917adb0` | 2026-11-03 | chore | chore(scoop): bucket manifest for 2.55.1 | not applicable | Scoop manifest. |  |
| `17e0e70` | 2026-11-04 | fix | fix(renderer): stop the WebGL cursor-blink interval when releasing the addon (#421) (#433) | ported | Builds on 9969f1e. | `5accb2a` |
| `d64c828` | 2026-11-04 | chore | chore(release): bump to 2.55.2 | not applicable | Release version bump. |  |
| `a8133fe` | 2026-11-04 | chore | chore(scoop): bucket manifest for 2.55.2 | not applicable | Scoop manifest. |  |
| `98bbf50` | 2026-11-04 | fix | fix(browser): stop Ctrl+W in the browser panel from quitting wmux (#431) | skipped | Browser only: Ctrl+W inside the browser panel. |  |
| `6807444` | 2026-11-04 | fix | fix(browser): let Ctrl+W close the browser tab from inside a page (#432) | skipped | Browser only: Ctrl+W inside the browser panel. |  |
| `72d246b` | 2026-11-04 | feat | feat(terminal): add a Clear terminal buffer action (#434) | ported | Feature the owner chose to port in the ledger review (2026-11-18). Clear terminal buffer action. | `8aa72aa` |
| `9f2cd1f` | 2026-11-04 | fix | fix(sidebar): derive agent rows from the shared roster (#435) | ported | Fix. | `5eb8869` |
| `3402b2e` | 2026-11-04 | feat | feat(wsl): install Claude Code hooks into running WSL distros (#428) | skipped | Feature. Port only if flagged. |  |
| `ff2179c` | 2026-11-04 | fix | fix(wsl): keep WSL Claude sessions through the startup prune (#428) | skipped | Fixes the WSL Claude hooks installer (3402b2e), which remotea doesn't have. Ports with it if that feature is flagged. |  |
| `a4a994e` | 2026-11-04 | fix | fix(wsl): throttle pane-open hook syncs instead of debouncing them (#428) | skipped | Fixes the WSL Claude hooks installer (3402b2e), which remotea doesn't have. Ports with it if that feature is flagged. |  |
| `0d516fb` | 2026-11-04 | fix | fix(wsl): never let the hook helper exit with the runtime's status (#428) | skipped | Fixes the WSL Claude hooks installer (3402b2e), which remotea doesn't have. Ports with it if that feature is flagged. |  |
| `67826e0` | 2026-11-04 | fix | fix(wsl): give a pane opened mid-wait its full boot window (#428) | skipped | Fixes the WSL Claude hooks installer (3402b2e), which remotea doesn't have. Ports with it if that feature is flagged. |  |
| `1efd2ac` | 2026-11-04 | chore | chore(release): bump to 2.56.0 | not applicable | Release version bump. |  |
| `35e16c9` | 2026-11-04 | chore | chore(scoop): bucket manifest for 2.56.0 | not applicable | Scoop manifest. |  |
| `dd21604` | 2026-11-04 | feat | feat: replace pane split dropdown with direct buttons (#436) | skipped | Feature. Split down is already in the split menu and has a shortcut; the tab bar stays lean. |  |
| `a3b4450` | 2026-11-04 | feat | feat(titlebar): add browser panel toggle (#437) | skipped | Feature. Port only if flagged. |  |
| `bbe4fb3` | 2026-11-04 | feat | feat(diagnostics): count live terminals and WebGL renderers in shipped builds (#421) | skipped | Feature. Port only if flagged. |  |
| `e568709` | 2026-11-04 | chore | chore(release): bump to 2.57.0 | not applicable | Release version bump. |  |
| `5168670` | 2026-11-04 | chore | chore(scoop): bucket manifest for 2.57.0 | not applicable | Scoop manifest. |  |
| `cd1e4f7` | 2026-11-06 | feat | feat(titlebar): ChatGPT Web dictation, opt-in (#438) | skipped | Feature. Port only if flagged. |  |
| `60560b7` | 2026-11-06 | chore | chore(release): bump to 2.58.0 | not applicable | Release version bump. |  |
| `ddad78f` | 2026-11-06 | chore | chore(scoop): bucket manifest for 2.58.0 | not applicable | Scoop manifest. |  |
| `7757de2` | 2026-11-06 | fix | fix(opencode): retry a TUI session report that never landed (#443) | ported | Fix. | `81b5bfc` |
| `898aa3d` | 2026-11-06 | chore | chore(release): bump to 2.58.1 | not applicable | Release version bump. |  |
| `18376ac` | 2026-11-07 | fix | fix(opencode): harden the server-half session reporter (#444) | ported | Fix. | `498d7f1` |
| `01f538d` | 2026-11-07 | fix | fix(cli): retry idempotent reports when the pipe is busy (#445) | ported | Fix. | `4e5f36c` |
| `98b4f66` | 2026-11-07 | fix | fix(diff): open the diff tab for any agent's edit tool, tint rows past the viewport (#440, #441) | ported | Fix. | `54a137b` |
| `5a9cf39` | 2026-11-07 | feat | feat: browser link menu and hover URL (#439), close to tray (#442) | skipped | Feature. Port only if flagged. |  |
| `0c02de5` | 2026-11-07 | chore | chore(release): bump to 2.59.0 | not applicable | Release version bump. |  |
| `1f2ffa9` | 2026-11-07 | chore | chore(scoop): bucket manifest for 2.59.0 | not applicable | Scoop manifest. |  |
| `e89ebe2` | 2026-11-09 | fix | fix(browser): open Ctrl+click and middle-click links in a new tab (#446) | skipped | Browser only: Ctrl+click and middle-click inside the browser panel. |  |
| `f1423b2` | 2026-11-09 | chore | chore(release): bump to 2.59.1 | not applicable | Release version bump. |  |
| `7f803d2` | 2026-11-09 | chore | chore(scoop): bucket manifest for 2.59.1 | not applicable | Scoop manifest. |  |
| `fa97b16` | 2026-11-10 | feat | feat(tabs): resume the just-closed tab's agent session on Ctrl+Shift+T (#447) | ported | Feature the owner chose to port in the ledger review (2026-11-18). Ctrl+Shift+T brings back the closed tab's agent session. | `a10bbe3` |
| `14d0096` | 2026-11-10 | chore | chore(release): bump to 2.60.0 | not applicable | Release version bump. |  |
| `090c13d` | 2026-11-10 | chore | chore(scoop): bucket manifest for 2.60.0 | not applicable | Scoop manifest. |  |
| `002db74` | 2026-11-13 | docs | docs(readme): lead with the wmux film and rewrite the README | not applicable | Documentation. |  |
| `72ef39e` | 2026-11-13 | docs | docs(readme): play the wmux film inline instead of the animated WebP | not applicable | Documentation. |  |
| `fbdaa7e` | 2026-11-13 | docs | docs(readme): show a clickable film poster instead of the video player | not applicable | Documentation. |  |
| `1d07ebe` | 2026-11-13 | untyped | Revert "docs(readme): show a clickable film poster instead of the video player" | not applicable | Reverts a README change. |  |
| `9816bd2` | 2026-11-13 | fix | fix(focus): return to the pane a workspace last had focused (#449) | ported | Fix. | `1ff0a8b` |
| `73b7980` | 2026-11-13 | feat | feat(diff): wrap long lines toggle in the Diff tab and Git view (#450) | skipped | Feature. Port only if flagged. |  |
| `e46ceb2` | 2026-11-13 | chore | chore(release): bump to 2.61.0 | not applicable | Release version bump. |  |
| `b9ff6d4` | 2026-11-13 | chore | chore(scoop): bucket manifest for 2.61.0 | not applicable | Scoop manifest. |  |
| `8483195` | 2026-11-13 | fix | fix(explorer): retry a no_root listing until the pane reports its cwd (#452) | ported | Fix. | `9184a9f` |
| `0da2a35` | 2026-11-13 | fix | fix(git): run git inside the distro for folders on a WSL share (#451) | ported | Fix. | `9d98a30` |
| `46c4c77` | 2026-11-13 | chore | chore(release): bump to 2.61.1 | not applicable | Release version bump. |  |
| `ac7d9d8` | 2026-11-13 | chore | chore(scoop): bucket manifest for 2.61.1 | not applicable | Scoop manifest. |  |
| `42c6df4` | 2026-11-15 | fix | fix(markdown): allow selecting and copying text in preview and source (#460) | ported | Fix. | `e7e9a6d` |
| `1266792` | 2026-11-15 | feat | feat(panes): show no focused pane in an unfocused window (#459) | ported | Feature the owner chose to port in the ledger review (2026-11-18). An unfocused window shows no focused pane. | `98890b2` |
| `b4003ba` | 2026-11-15 | fix | fix(sidebar): keep keyboard focus in the focused pane on sidebar clicks (#458) | ported | Fix. | `59315cd` |
| `e67e7be` | 2026-11-15 | fix | fix(notifications): bring the window forward when a toast is clicked (#457) | ported | Fix. | `e83508c` |
| `0492b10` | 2026-11-15 | fix | fix(markdown): resolve WSL paths for the Windows host (#456) | ported | Fix. | `b69a5a5` |
| `427db79` | 2026-11-15 | feat | feat(panes): lock a pane against spawned agents and moved tabs (#454) | skipped | Feature. Port only if flagged. |  |
| `62724b0` | 2026-11-15 | fix | fix(panes): lock toggle targets its own workspace; keep the lock out of the global context stub | skipped | Follow-up to the pane lock feature (427db79), which remotea doesn't have. Ports with it if that feature is flagged. |  |
| `d68414e` | 2026-11-15 | fix | fix(terminal): read Shift off the modifier flags, not the letter's case (#453) | ported | Fix. | `9cd5af8` |
| `5fd35ab` | 2026-11-15 | chore | chore(cli): regenerate resources/cli/wmux.js for the WSL markdown path fix (#456) | not applicable | Regenerated `resources/cli`; remotea regenerates its own and never merges it by hand. |  |
| `fc35f15` | 2026-11-15 | chore | chore(release): bump to 2.62.0 | not applicable | Release version bump. |  |
| `1fe6bdb` | 2026-11-15 | chore | chore(scoop): bucket manifest for 2.62.0 | not applicable | Scoop manifest. |  |
| `3ee1c06` | 2026-11-17 | feat | feat(sidebar): add set-indicator / clear-indicator for a workspace pill (#461) | skipped | Feature. Port only if flagged. |  |
| `4bd5eba` | 2026-11-17 | chore | chore(release): bump to 2.63.0 | not applicable | Release version bump. |  |
| `81d8916` | 2026-11-17 | chore | chore(scoop): bucket manifest for 2.63.0 | not applicable | Scoop manifest. |  |
| `ad75bd9` | 2026-11-18 | feat | feat(agent-browser): show and control the agent browser page in wmux (#455) | skipped | Feature. Port only if flagged. |  |
| `c5d7b25` | 2026-11-18 | fix | fix(sidebar): highlight the collapsed sidebar's expand strip instead of widening it (#462) | ported | Fix. | `0afc820` |
| `72452e5` | 2026-11-18 | chore | chore(cli): regenerate resources/cli/wmux.js for the agent browser page view (#455) | not applicable | Regenerated `resources/cli` for a browser feature. |  |
| `aa15bcb` | 2026-11-18 | chore | chore(release): bump to 2.64.0 | not applicable | Release version bump. |  |
| `f289014` | 2026-11-18 | chore | chore(scoop): bucket manifest for 2.64.0 | not applicable | Scoop manifest. |  |

## Later fixes

wmux fixes made after the commits above, picked up by hand. Add a row with the same columns when one is ported.

| sha | date | type | subject | ruling | reason | ported as |
|---|---|---|---|---|---|---|
