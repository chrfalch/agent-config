## iOS build folders

One build folder per worktree and configuration, reused by every later build.

A session scratchpad is `/tmp/claude-<uid>/<project>/<session-id>/scratchpad`. Every
session gets a new id, so a build folder written there can never be reused. It is
pure cost. Measured on one machine on 2026-10-08: three such folders held 17.4 GB,
and the scratchpad root held 23 GB.

- Get the folder with `bin/cc-dd-path <configuration>` from the agent-config repo.
  It prints one fixed path and creates it.
- Pass that path to `xcodebuild -derivedDataPath`. Use the same path for every later
  build of the same worktree and the same configuration.
- Write the path in full in the command, not in a shell variable such as `$D`. The
  hook reads the command text and cannot see what a variable holds.
- For an app in another repository, such as `~/issues/<app>`, run `cc-dd-path` in
  that app's folder and pass the path it prints. Name the app with `-workspace` or
  `-project`, or start the command with `cd <app> &&`.
- Name the configuration for what changes the output: `Debug-sim`, `Release-sim`,
  `Debug-device`.
- Never put a build folder in the session scratchpad, in `/tmp`, or in the worktree.
- A clean build is `xcodebuild clean` in the shared folder, not a new folder.
- `bin/cc-worktree-retire` deletes the worktree's `cc-dd-path` build folders after
  it removes the worktree.
- Repo tooling that computes its own derived-data path is out of scope. Do not
  override it.

A `PreToolUse` hook denies any other `-derivedDataPath`. The deny message names the
path to use.
