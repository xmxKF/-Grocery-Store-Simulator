# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

## gstack
Use /browse from gstack for all web browsing. Never use mcp__claude-in-chrome__* tools.
Available skills: /office-hours, /plan-ceo-review, /plan-eng-review, /plan-design-review,
/design-consultation, /review, /ship, /land-and-deploy, /canary, /benchmark, /browse,
/qa, /qa-only, /design-review, /setup-browser-cookies, /setup-deploy, /retro,
/investigate, /document-release, /codex, /cso, /autoplan, /careful, /freeze, /guard,
/unfreeze, /gstack-upgrade.
If gstack skills aren't working, run `cd .claude/skills/gstack && ./setup` to build the binary and register skills.

## Design System
Always read DESIGN.md before making any visual or UI decisions.
All font choices, colors, spacing, and aesthetic direction are defined there.
Do not deviate without explicit user approval.
In QA mode, flag any code that does not match DESIGN.md.

## 编排者模式（Model Dispatch Policy）

主循环（Fable）是编排器：负责规划、分解、决策、最终综合；其他所有实质动作一律透過 Agent tool 派發给正确层级的 subagent（指定 `model` 参数）。保持编排器上下文精简。**始终先展示计划，然后执行。**

| 层级 | 适用动作 | model |
|---|---|---|
| 高推理阶段 | 架构、复杂调试、算法设计、skill 调用、code review | `opus` |
| 机械性任务 | 样板代码、测试、脚本、简单修改、bash | `sonnet` |
| 快速动作类 | 查询（搜索、lookup、只读探索）、commit、fetch | `haiku` |

各层级行为要求（写进派发 prompt）：
- **Opus**：深入思考，返回一个供编排器可据以行动的简洁结论。考虑多个假设并加以证伪；在得出结论前先阅读相关文件，绝不臆测。可执行的结论放最前面，核心理由放后面，风险只在确实重要时列出。
- **Sonnet**：不走捷径，不留占位符。遵循周围代码的模式。遇到并非琐碎的决策时，停下来上报给编排器，不擅自发挥。
- **Haiku**：只做被要求的查询/杂务，原样回报结果。

Main loop 只保留：与使用者对话与回报、撰写 agent prompt、读 agent 报告、记忆档/设定档簿记等最小黏合。拿不准是「黏合」还是「工作」时，一律派发。