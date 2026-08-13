---
name: git-commit
description: Git commit conventions - standardized commit message format and workflow
---

# Git Commit Instructions

格式化并提交代码变更，使用 pre-commit 钩子和 conventional commit 消息格式。

## 目标

1. 检查并 stage 待提交的变更
2. **如果存在 pre-commit 配置**：运行格式化代码
3. 分析变更内容和目的
4. 生成符合规范的 commit message
5. 提交变更

## Commit Process

1. Use `git --no-pager status` to check if there are pending changes to commit. **Important**: Only stage files relevant to the current change — carefully review untracked files (especially binary/data files like `*.png`, `*.log`), do NOT blindly `git add .` or `git add -A`.

2. **If a file has both staged and unstaged changes**: 
   - Use `git --no-pager diff --staged <file>` and `git --no-pager diff <file>` (via `bash`) to view both versions
   - **Stop the process** and ask the user (in your reply) how to proceed:
     - Stage all changes for this file
     - Only commit staged changes (leave unstaged for later)
     - Stage unstaged changes to a new file

3. If no staged changes exist, stage all changes. If staged changes already exist, only process the staged changes.

4. **If `.pre-commit-config.yaml` exists**: Run `pre-commit run` to format code

5. **If pre-commit was run and code was modified by formatting tools**: stage the formatting tool's changes

6. Use `git --no-pager diff --staged` (via `bash`) to check the staged changes. **Important**: Do NOT read changes to binary files or data files.

7. If `git --no-pager diff --staged` cannot reflect the full scope or purpose of changes, use `read` and `grep`/`find` to inspect corresponding code files and deepen understanding.

8. Generate commit message according to rules (Chinese for subject and body, except type).

9. Present the **complete commit message** to the user for review in your reply (inside a fenced code block). **Critical**: the user must SEE the actual message — do NOT ask "确认提交？" without showing the message content.

10. If user agrees, commit via `bash`. Otherwise, modify according to user's request.

11. **If commit is blocked by pre-commit**: refer to step 5 to stage formatting tool changes and **re-commit**. **Important**: A commit blocked by pre-commit did not actually succeed, so **cannot** use amend to modify. Should re-commit instead.

12. **If commit fails with GPG signing error** (e.g., `gpg failed to sign the data`, lock timeout):
    - Check `git --no-pager log --show-signature -1` to confirm signing is configured
    - Find stale lock: `find ~/.gnupg -name "*.lock"` (via `bash`)
    - If the locking process is dead (`ps -p <pid>` shows nothing), remove the stale lock: `rm -f ~/.gnupg/public-keys.d/pubring.db.lock`
    - If still stuck: `gpgconf --kill gpg-agent` (agent auto-restarts on next use), then retry
    - As last resort, commit without signing: `git -c commit.gpgsign=false commit -m "..."` (unsigned; can amend-and-sign later)

## Conventional Commit Message Format

Commit messages consist of three parts: Header, Body, and Footer.

```
<type>(<scope>): <subject>
// blank line
<body>
// blank line
<footer>
```

Header is required, Body and Footer can be omitted.

Regardless of which part, no line should exceed 72 characters (or 100 characters). This is to avoid automatic line wrapping affecting aesthetics.

### Header

Header has only one line, including three fields: type (required), scope (optional), and subject (required).

#### Type

Type indicates the category of commit. Only the following 7 identifiers are allowed:

- **feat**: New feature
- **fix**: Bug fix
- **docs**: Documentation
- **style**: Formatting (changes that don't affect code execution)
- **refactor**: Refactoring (code changes that are neither new features nor bug fixes)
- **test**: Add tests
- **chore**: Build process or auxiliary tool changes

#### Scope

Scope indicates the scope affected by the commit, such as data layer, control layer, view layer, etc. Varies by project.

#### Subject

Subject is a brief description of the commit purpose, not exceeding 50 characters.

- Use Chinese for the description (except for type)
- Start with a verb, e.g., "添加" not "添加了"; "修改" not "修改了"
- First letter lowercase
- No period (.) at the end

### Body

Body is a detailed description of this commit, can be split into multiple lines. Example:

```
More detailed explanatory text, if necessary. Wrap it to
about 72 characters or so.

Further paragraphs come after blank lines.

- Bullet points are okay, too
- Use a hanging indent
```

Two important notes:

1. Use Chinese for the description
2. Should explain the motivation for code changes, and comparison with previous behavior

### Footer

Footer is only used in two situations.

#### Incompatible Changes

If current code is incompatible with previous version, Footer starts with BREAKING CHANGE, followed by description of changes, reasons, and migration methods.

```
BREAKING CHANGE: isolate scope bindings definition has changed.

    To migrate the code follow the example below:

    Before:

    scope: {
      myAttr: 'attribute',
    }

    After:

    scope: {
      myAttr: '@',
    }

    The removed `inject` wasn't generally useful for directives so there should be no code using it.
```

#### Closing Issues

If current commit addresses an issue, you can close that issue in the Footer.

```
Closes #234
```

Can also close multiple issues at once.

```
Closes #123, #245, #992
```

### Revert

There's a special case: if current commit is used to revert a previous commit, it must start with `revert:`, followed by the Header of the reverted commit.

```
revert: feat(pencil): 添加图表宽度选项

This reverts commit 667ecc1654a317a13331b17617d973392f415f02.
```

The Body format is fixed, must be written as `This reverts commit <hash>`, where hash is the SHA identifier of the reverted commit.

If current commit and reverted commit are in the same release, neither will appear in Changelog. If they are in different releases, current commit will appear under the Reverts subsection in Changelog.
