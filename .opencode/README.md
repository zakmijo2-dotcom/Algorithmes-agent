# Algorithme AI Agent for OpenCode

**Deterministic Security Guardrails, Custom Tools & Multi-Agent Architecture for OpenCode**

This repository contains the ported features of **Algorithme AI Agent** configured natively for **OpenCode** (TUI & CLI).

---

## 🌟 Key Features

- **Security Guardrails Plugin** (`security-guardrails.ts`): Enforces path traversal sandbox checks (`resolvePathSafe`) and blocks dangerous/destructive shell commands (`rm -rf /`, `mkfs`, credential leaks, `sudo`, etc.).
- **Secret Redaction Plugin** (`secret-masker.ts`): Automatically masks API keys, bearer tokens, AWS keys, GitHub tokens, and sensitive passwords from output streams.
- **Sandboxed Execution Tools**:
  - `safe_bash`: Sandboxed shell execution wrapper.
  - `file_edit`: Precision string search and replace tool.
  - `diff_apply`: Line diff inspection tool against `git HEAD` or between files.
- **Custom Agents**:
  - `algorithme-coder`: Autonomous coding agent configured with security tools.
  - `algorithme-auditor`: Security auditor sub-agent for code reviews and vulnerability analysis.

---

## 📁 Directory Structure

```
.opencode/
├── opencode.json
├── README.md
├── agents/
│   ├── algorithme-coder.md
│   └── algorithme-auditor.md
├── plugins/
│   ├── security-guardrails.ts
│   └── secret-masker.ts
└── tools/
    ├── safe_bash.ts
    ├── file_edit.ts
    └── diff_apply.ts
```

---

## 🛠️ Quick Start

### 1. Installation

You can install this OpenCode configuration globally or per project:

#### Global Setup (All Projects)
```bash
cp -r /root/.opencode ~/.config/opencode
```

#### Project Setup (Local Repo)
```bash
cp -r /root/.opencode ./.opencode
```

### 2. Launching with OpenCode

Start OpenCode using the `algorithme-coder` agent:

```bash
opencode --agent algorithme-coder
```

Or switch to the auditor agent inside OpenCode:

```bash
/agent algorithme-auditor
```
