# Auto Mode Prompt Audit (Public npm 2.1.107)

Date: 2026-04-14

This file records the prompt provenance for Claude Code public `auto mode` before syncing any local source files.

## Package checked

- npm package: `@anthropic-ai/claude-code`
- `latest`: `2.1.107`
- `stable`: `2.1.92`
- tarball: `https://registry.npmjs.org/@anthropic-ai/claude-code/-/claude-code-2.1.107.tgz`
- unpacked at: `/tmp/claude-code-2.1.107/package`

## Source of truth

For public/local behavior, the best source of truth is the latest published `cli.js`, not a handwritten placeholder and not the sibling prompt repo by itself.

Relevant locations in the public package:

- Base classifier prompt: [/tmp/claude-code-2.1.107/package/cli.js](/tmp/claude-code-2.1.107/package/cli.js:2296)
- External permissions template: [/tmp/claude-code-2.1.107/package/cli.js](/tmp/claude-code-2.1.107/package/cli.js:2386)
- XML output-format replacement: [/tmp/claude-code-2.1.107/package/cli.js](/tmp/claude-code-2.1.107/package/cli.js:2482)
- Public build uses external permissions template directly: [/tmp/claude-code-2.1.107/package/cli.js](/tmp/claude-code-2.1.107/package/cli.js:2448)
- Public build has no separate Anthropics-only permissions body: [/tmp/claude-code-2.1.107/package/cli.js](/tmp/claude-code-2.1.107/package/cli.js:2488)

## How public auto mode is assembled

The public bundle does not store the final prompt as one single source file. It is composed at runtime from three parts:

1. A base classifier prompt string.
2. An external permissions template string inserted into `<permissions_template>`.
3. A code-side replacement that swaps `Use the classify_result tool...` for the XML output instructions:
   - `<block>yes</block><reason>one short sentence</reason>`
   - `<block>no</block>`

This means the text the model actually receives is:

- `base prompt`
- plus `external permissions template`
- plus `XML output format block`

## Public-build conclusions

- Public `auto mode` prompt is already embedded in the latest npm `cli.js`.
- Public build does not expose a separate `permissions_anthropic` body; the variable is empty in `2.1.107`.
- For public behavior, inventing a custom internal permissions template is the wrong baseline.
- The sibling repo `claude-code-system-prompts` is useful as a reference, but the public npm bundle is the stronger source when the target is public Claude Code behavior.

## Local repo contrast

Current local source still wires `auto mode` through local prompt assets:

- [src/utils/permissions/yoloClassifier.ts](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/src/utils/permissions/yoloClassifier.ts:54)

Current local recovered source includes:

- `auto_mode_system_prompt.txt`
- `permissions_external.txt`
- `permissions_anthropic.txt`

Current local built artifact still contains the older placeholder-style prompt, not the newer public `2.1.107` text:

- [release/cc-v2.1.88/cli.js](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/release/cc-v2.1.88/cli.js:288203)
- [dist/cli.js](/Users/zfang/workspace/zenfun-code/cc-v2.1.88-full/dist/cli.js:288203)

## Practical sync rule

If we later sync local source to the latest public behavior, the safe order should be:

1. Treat public `cli.js` as the baseline for `auto mode`.
2. Reconstruct local `auto_mode_system_prompt.txt` and `permissions_external.txt` from the latest public bundle.
3. Do not invent a public-facing `permissions_anthropic.txt` unless there is evidence of a real source for it.
4. Rebuild only after the prompt resources are aligned.

## Status

No runtime code was changed as part of this note.
This file is only a research snapshot to drive a later, explicit sync step.
