#!/usr/bin/env python3
"""
Obsidian Scribe CLI
Scans and completes (scribe: ...) tags in Obsidian notes using local Ollama (RTX 4070)
or remote OpenWebUI (ai.ilovemyhonda.fit) with deep-thinking routing, thinking text, and resource metrics.
"""

import sys
import os
import re
import json
import time
import subprocess
import urllib.request
import urllib.error
from pathlib import Path

# Paths
DEFAULT_VAULT = Path("/home/ehren/Documents/Main Vault")
PLUGIN_DATA_PATH = DEFAULT_VAULT / ".obsidian/plugins/obsidian-openwebui-scribe/data.json"
CONFIG_PATH = Path.home() / ".config/obsidian-scribe/config.json"
LOCAL_REST_API_DATA = DEFAULT_VAULT / ".obsidian/plugins/obsidian-local-rest-api/data.json"

DEFAULT_CONFIG = {
    "localOllamaUrl": "http://localhost:11434",
    "localDefaultModel": "qwen3:8b",
    "localDeepModel": "qwen3.6:27b",
    "remoteUrl": "https://ai.ilovemyhonda.fit",
    "remoteApiKey": "",
    "remoteDefaultModel": "qwen3:8b",
    "remoteDeepModel": "qwen3.6:27b",
    "fastTarget": "local",       # "local" or "remote"
    "deepTarget": "remote",      # "local" or "remote"
    "debugMode": True,           # show thinking & resource metrics
    "showThinkingInNote": True,  # embed collapsible callout in note
    "deepFlags": ["-d", "--deep", "deep:", "think:"],
    "verboseFlags": ["-v", "--verbose"],
    "systemPrompt": (
        "You are Obsidian Scribe, a concise, high-density note-taking assistant integrated into an Obsidian vault.\n"
        "RULES:\n"
        "1. Provide direct, high-density responses. No conversational filler, no pleasantries (never say 'Sure!', 'Certainly!', or 'Here is...').\n"
        "2. Match the exact markdown style, formatting, and indentation of the surrounding notes.\n"
        "3. Output ONLY the replacement text for the (scribe:...) tag.\n"
        "4. If -v or -verbose is specified, provide a thorough, detailed explanation."
    )
}

def load_config():
    config = dict(DEFAULT_CONFIG)
    if PLUGIN_DATA_PATH.exists():
        try:
            with open(PLUGIN_DATA_PATH, "r", encoding="utf-8") as f:
                config.update(json.load(f))
        except Exception:
            pass
    if CONFIG_PATH.exists():
        try:
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                config.update(json.load(f))
        except Exception:
            pass
    return config

def get_gpu_metrics():
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"],
            timeout=2, stderr=subprocess.DEVNULL
        ).decode("utf-8").strip()
        parts = [p.strip() for p in out.split(",")]
        if len(parts) >= 4:
            return {
                "util": f"{parts[0]}%",
                "vramUsed": f"{int(parts[1])/1024:.1f} GB",
                "vramTotal": f"{int(parts[2])/1024:.1f} GB",
                "temp": f"{parts[3]}°C"
            }
    except Exception:
        pass
    return None

def parse_tag(raw_instruction, config):
    instruction = raw_instruction.strip()
    is_deep = False
    is_verbose = False

    for flag in config.get("deepFlags", ["-d", "--deep", "deep:", "think:"]):
        clean_flag = flag.rstrip(':')
        flag_re = re.compile(rf'(?:^|\s){re.escape(clean_flag)}(?::|\s|$)', re.IGNORECASE)
        if flag_re.search(instruction):
            is_deep = True
            instruction = flag_re.sub(' ', instruction).strip()

    for flag in config.get("verboseFlags", ["-v", "--verbose"]):
        clean_flag = flag.rstrip(':')
        flag_re = re.compile(rf'(?:^|\s){re.escape(clean_flag)}(?::|\s|$)', re.IGNORECASE)
        if flag_re.search(instruction):
            is_verbose = True
            instruction = flag_re.sub(' ', instruction).strip()

    # Clean up leading colons, hyphens, or whitespace
    instruction = re.sub(r'^[:\-\s]+', '', instruction).strip()

    return instruction, is_deep, is_verbose

def query_local_ollama(prompt, system_prompt, model_name, base_url, timeout=90):
    url = f"{base_url.rstrip('/')}/api/chat"
    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt}
        ],
        "stream": False,
        "options": {
            "temperature": 0.2
        }
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        res = json.loads(resp.read().decode("utf-8"))
        msg = res.get("message", {})
        raw_content = msg.get("content", "")
        thinking = msg.get("thinking")

        think_match = re.search(r'<think>([\s\S]*?)</think>', raw_content, re.IGNORECASE)
        if think_match:
            if not thinking:
                thinking = think_match.group(1).strip()
            raw_content = re.sub(r'<think>[\s\S]*?</think>', '', raw_content, flags=re.IGNORECASE).strip()

        tok_per_sec = None
        duration_sec = None
        if res.get("eval_duration") and res.get("eval_count"):
            tok_per_sec = f"{(res['eval_count'] / res['eval_duration']) * 1e9:.1f}"
        if res.get("total_duration"):
            duration_sec = f"{res['total_duration'] / 1e9:.2f}"

        return {
            "content": raw_content.strip(),
            "thinking": thinking.strip() if thinking else None,
            "metrics": {
                "target": "Local Ollama",
                "model": model_name,
                "tokPerSec": tok_per_sec,
                "durationSec": duration_sec,
                "evalCount": res.get("eval_count"),
                "promptTokens": res.get("prompt_eval_count")
            }
        }

def query_remote_openwebui(prompt, system_prompt, model_name, remote_url, api_key, timeout=90):
    base_url = remote_url.rstrip('/')
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    }
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    start_time = time.time()
    url = f"{base_url}/api/chat/completions"
    payload = {
        "model": model_name,
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": prompt}
        ],
        "temperature": 0.2,
        "stream": False
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        res = json.loads(resp.read().decode("utf-8"))
        msg = res["choices"][0]["message"]
        raw_content = msg.get("content", "")
        thinking = msg.get("thinking")

        think_match = re.search(r'<think>([\s\S]*?)</think>', raw_content, re.IGNORECASE)
        if think_match:
            if not thinking:
                thinking = think_match.group(1).strip()
            raw_content = re.sub(r'<think>[\s\S]*?</think>', '', raw_content, flags=re.IGNORECASE).strip()

        duration_sec = f"{time.time() - start_time:.2f}"
        usage = res.get("usage", {})
        comp_tokens = usage.get("completion_tokens")
        tok_per_sec = f"{comp_tokens / float(duration_sec):.1f}" if comp_tokens and float(duration_sec) > 0 else None

        return {
            "content": raw_content.strip(),
            "thinking": thinking.strip() if thinking else None,
            "metrics": {
                "target": "Remote OpenWebUI",
                "model": model_name,
                "tokPerSec": tok_per_sec,
                "durationSec": duration_sec,
                "evalCount": comp_tokens,
                "promptTokens": usage.get("prompt_tokens")
            }
        }

def find_target_span(full_text, tag_start, tag_end, instruction):
    lower_instr = instruction.lower()

    # 1. List Transformation
    list_keywords = ["reorder", "re-order", "sort", "rank", "prioritize", "reverse", "table", "dedup", "alphabetize"]
    if any(k in lower_instr for k in list_keywords):
        preceding = full_text[:tag_start]
        lines = preceding.split("\n")
        end_idx = len(lines) - 1
        while end_idx >= 0 and not lines[end_idx].strip():
            end_idx -= 1
        start_idx = end_idx
        while start_idx >= 0 and re.match(r'^(?:[-*+]|\d+\.)\s+', lines[start_idx].strip()):
            start_idx -= 1
        if start_idx < end_idx:
            list_lines = lines[start_idx + 1:end_idx + 1]
            list_block_str = "\n".join(list_lines)
            block_start = preceding.rfind(list_block_str)
            if block_start != -1:
                return {
                    "type": "list",
                    "target_start": block_start,
                    "target_end": tag_end,
                    "target_text": full_text[block_start:tag_end],
                    "hint": "Target: Reorder or transform the preceding list block. Output ONLY the complete reordered/reformatted list matching markdown list style."
                }

    # 2. Line Rewrite / "Explain this better"
    rewrite_keywords = ["explain this better", "rephrase", "rewrite", "reword", "elaborate", "expand this", "make clearer", "clean up this"]
    if any(k in lower_instr for k in rewrite_keywords):
        line_start = full_text.rfind("\n", 0, tag_start) + 1
        line_before = full_text[line_start:tag_start]
        match = re.match(r'^(\s*(?:[-*+]|\d+\.)?\s*(?:\*\*[^*]+\*\*|__[^_]+__|[^:]+:)?\s*)(.*)$', line_before)
        if match and match.group(2).strip():
            prefix = match.group(1)
            target_start = line_start + len(prefix)
            return {
                "type": "line_rewrite",
                "prefix": prefix.strip(),
                "target_start": target_start,
                "target_end": tag_end,
                "target_text": full_text[target_start:tag_end],
                "hint": f"Target: Refine and explain the concept following '{prefix.strip()}'. Provide ONLY the polished definition/explanation. Do NOT repeat '{prefix.strip()}'."
            }

    # 3. Default: Inline tag
    return {
        "type": "inline",
        "target_start": tag_start,
        "target_end": tag_end,
        "target_text": full_text[tag_start:tag_end],
        "hint": None
    }

def call_ai(instruction, is_deep, is_verbose, context, file_path, config, hint=None):
    preferred_target = config.get("deepTarget", "remote") if is_deep else config.get("fastTarget", "local")
    local_model = config["localDeepModel"] if is_deep else config["localDefaultModel"]
    remote_model = config["remoteDeepModel"] if is_deep else config["remoteDefaultModel"]
    timeout = 180 if is_deep else 90

    sys_prompt = config["systemPrompt"]
    if is_verbose:
        sys_prompt += "\nNote: Detailed verbose breakdown requested (-v)."

    full_prompt = (
        f"Document Path: {file_path}\n\n"
        f"Document Context:\n\"\"\"\n{context}\n\"\"\"\n\n"
        f"Instruction/Tag: {instruction}\n"
    )
    if hint:
        full_prompt += f"\nTask Guidance: {hint}\n"
    else:
        full_prompt += "\nProvide ONLY the replacement text for the (scribe: ...) command tag. Do not repeat the prompt.\n"

    result = None
    if preferred_target == "local":
        try:
            print(f"  -> Routing to Local Ollama [{local_model}]...")
            result = query_local_ollama(full_prompt, sys_prompt, local_model, config["localOllamaUrl"], timeout=timeout)
        except Exception as local_err:
            print(f"  [!] Local Ollama failed ({local_err}). Falling back to remote {config['remoteUrl']} [{remote_model}]...")
            result = query_remote_openwebui(full_prompt, sys_prompt, remote_model, config["remoteUrl"], config.get("remoteApiKey", ""), timeout=timeout)
    else:
        try:
            print(f"  -> Routing to Remote OpenWebUI [{remote_model}]...")
            result = query_remote_openwebui(full_prompt, sys_prompt, remote_model, config["remoteUrl"], config.get("remoteApiKey", ""), timeout=timeout)
        except Exception as remote_err:
            print(f"  [!] Remote OpenWebUI failed ({remote_err}). Falling back to Local Ollama [{local_model}]...")
            result = query_local_ollama(full_prompt, sys_prompt, local_model, config["localOllamaUrl"], timeout=timeout)

    result["gpuMetrics"] = get_gpu_metrics()
    return result

def format_output_with_debug(ai_result, config):
    content = ai_result["content"]
    thinking = ai_result.get("thinking")
    metrics = ai_result.get("metrics", {})
    gpu = ai_result.get("gpuMetrics")

    if not config.get("debugMode", False):
        return content

    stats_parts = [f"**Model:** `{metrics.get('model')}` ({metrics.get('target')})"]
    if metrics.get("durationSec"):
        stats_parts.append(f"**Time:** {metrics['durationSec']}s")
    if metrics.get("tokPerSec"):
        stats_parts.append(f"**Speed:** {metrics['tokPerSec']} tok/s")
    if gpu:
        stats_parts.append(f"**VRAM:** {gpu['vramUsed']} / {gpu['vramTotal']} | **GPU:** {gpu['util']} ({gpu['temp']})")

    stats_line = " | ".join(stats_parts)

    # CLI Terminal debug print
    print(f"  [DEBUG] {stats_line}")
    if thinking:
        preview = thinking[:120].replace('\n', ' ')
        print(f"  [THINKING] {preview}...")

    if not config.get("showThinkingInNote", False):
        return content

    callout = f"> [!NOTE]- 🧠 Scribe Thought & Resource Metrics\n> {stats_line}\n"
    if thinking:
        callout += ">\n> **Thought Process:**\n"
        for line in thinking.strip().split("\n"):
            callout += f"> {line}\n"

    return f"{callout}\n{content}"

def process_text_content(content, file_path, config):
    tag_pattern = re.compile(r'\(scribe(?::|\s+)([\s\S]*?)\)', re.IGNORECASE)
    matches = list(tag_pattern.finditer(content))
    if not matches:
        return content, 0

    print(f"Found {len(matches)} tag(s) in {file_path}")
    updated = content
    for match in matches:
        full_tag = match.group(0)
        raw_instruction = match.group(1)
        instruction, is_deep, is_verbose = parse_tag(raw_instruction, config)
        span = find_target_span(updated, match.start(), match.end(), instruction)

        mode_str = f"Deep ({config.get('deepTarget', 'remote')})" if is_deep else f"Fast ({config.get('fastTarget', 'local')})"
        type_str = f" [{span['type'].upper()}]" if span['type'] != "inline" else ""
        print(f"  Processing tag: '{instruction[:40]}...' [{mode_str}]{type_str}")

        try:
            ai_result = call_ai(instruction, is_deep, is_verbose, updated, file_path, config, hint=span["hint"])
            replacement = format_output_with_debug(ai_result, config)
            updated = updated.replace(span["target_text"], replacement, 1)
            print(f"  ✓ Replaced successfully.")
        except Exception as e:
            print(f"  ✗ Error processing tag: {e}")

    return updated, len(matches)

def get_obsidian_rest_api_info():
    if not LOCAL_REST_API_DATA.exists():
        return None, None
    try:
        with open(LOCAL_REST_API_DATA, "r", encoding="utf-8") as f:
            data = json.load(f)
            port = data.get("insecurePort", 27123)
            key = data.get("apiKey", "")
            return f"http://127.0.0.1:{port}", key
    except Exception:
        return None, None

def process_active_obsidian(config):
    base_url, api_key = get_obsidian_rest_api_info()
    if not base_url or not api_key:
        print("[!] Obsidian Local REST API not configured. Looking for recently modified note...")
        return process_most_recent(config)

    headers = {"Authorization": f"Bearer {api_key}"}
    try:
        req = urllib.request.Request(f"{base_url}/active/", headers=headers)
        with urllib.request.urlopen(req, timeout=3) as resp:
            content = resp.read().decode("utf-8")
            file_loc = resp.headers.get("Content-Location", "active_note.md")
            file_path = urllib.parse.unquote(file_loc)

        print(f"Active note in Obsidian: {file_path}")
        updated, count = process_text_content(content, file_path, config)
        if count == 0:
            print("No (scribe:...) tags found in active note.")
            return

        put_req = urllib.request.Request(
            f"{base_url}/active/",
            data=updated.encode("utf-8"),
            headers={"Authorization": f"Bearer {api_key}", "Content-Type": "text/markdown"},
            method="PUT"
        )
        with urllib.request.urlopen(put_req, timeout=5) as put_resp:
            print(f"✓ Updated active note in Obsidian ({count} tag(s) resolved)!")
    except urllib.error.URLError:
        print("[!] Obsidian REST API not reachable (is Obsidian open?). Checking disk...")
        process_most_recent(config)

def process_file(file_path, config):
    p = Path(file_path).resolve()
    if not p.exists() or not p.is_file():
        print(f"Error: File '{file_path}' not found.")
        return
    with open(p, "r", encoding="utf-8") as f:
        content = f.read()

    updated, count = process_text_content(content, str(p), config)
    if count > 0:
        with open(p, "w", encoding="utf-8") as f:
            f.write(updated)
        print(f"✓ Saved {count} change(s) to {p}")
    else:
        print(f"No (scribe:...) tags found in {p}")

def process_most_recent(config):
    vault = DEFAULT_VAULT
    md_files = [f for f in vault.rglob("*.md") if ".obsidian" not in str(f) and "_gemini-scribe" not in str(f)]
    if not md_files:
        print("No markdown files found in vault.")
        return
    latest_file = max(md_files, key=lambda f: f.stat().st_mtime)
    print(f"Most recently modified file: {latest_file.relative_to(vault)}")
    process_file(latest_file, config)

def scan_vault(vault_dir, config):
    vault = Path(vault_dir).resolve()
    print(f"Scanning vault: {vault}...")
    tag_pattern = re.compile(r'\(scribe(?::|\s+)([\s\S]*?)\)', re.IGNORECASE)
    md_files = [f for f in vault.rglob("*.md") if ".obsidian" not in str(f) and "_gemini-scribe" not in str(f)]

    found_files = []
    for f in md_files:
        try:
            with open(f, "r", encoding="utf-8") as fh:
                if tag_pattern.search(fh.read()):
                    found_files.append(f)
        except Exception:
            continue

    if not found_files:
        print("No files with (scribe:...) tags found in vault.")
        return

    print(f"Found {len(found_files)} note(s) with tags. Processing...")
    for f in found_files:
        process_file(f, config)

def test_connections(config):
    print("Testing Scribe AI connections & routing:")
    print(f"-> Standard 8B routing target:    {config.get('fastTarget', 'local').upper()}")
    print(f"-> Deep thinking routing target:  {config.get('deepTarget', 'remote').upper()}")
    print(f"-> Debug Mode:                    {'ENABLED' if config.get('debugMode') else 'DISABLED'}")
    print(f"-> Embed Callout in Notes:        {'ENABLED' if config.get('showThinkingInNote') else 'DISABLED'}")

    # 1. Local Ollama
    local_url = config['localOllamaUrl'].rstrip('/')
    print(f"\n1. Local Ollama ({local_url}):")
    try:
        req = urllib.request.Request(f"{local_url}/api/tags")
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            models = [m["name"] for m in data.get("models", [])]
            print(f"   ✓ Online! Available models: {', '.join(models)}")
    except Exception as e:
        print(f"   ✗ Offline / Error: {e}")

    # 2. Remote OpenWebUI
    remote_url = config['remoteUrl'].rstrip('/')
    print(f"\n2. Remote OpenWebUI ({remote_url}):")
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
        if config.get("remoteApiKey"):
            headers["Authorization"] = f"Bearer {config['remoteApiKey']}"
        req = urllib.request.Request(f"{remote_url}/api/models", headers=headers)
        with urllib.request.urlopen(req, timeout=8) as resp:
            res_data = json.loads(resp.read().decode("utf-8"))
            remote_models = [m["id"] for m in res_data.get("data", [])]
            print(f"   ✓ Connected! (HTTP {resp.status})")
            print(f"   ✓ Remote Models: {', '.join(remote_models)}")
    except Exception as e:
        print(f"   ✗ Connection failed: {e}")

    # 3. GPU Stats
    gpu = get_gpu_metrics()
    print(f"\n3. Local GPU Telemetry:")
    if gpu:
        print(f"   ✓ Utilization: {gpu['util']} | VRAM: {gpu['vramUsed']} / {gpu['vramTotal']} | Temp: {gpu['temp']}")
    else:
        print("   [!] nvidia-smi not responding or unavailable.")

def print_help():
    print("""Obsidian Scribe CLI
Usage:
  scribe                     Process (scribe:...) tags in active Obsidian note
  scribe active              Same as above (via Obsidian Local REST API)
  scribe scan [path]         Scan entire vault (or folder) and complete tags
  scribe file <path>         Process a specific markdown file
  scribe test                Test local Ollama & remote OpenWebUI connections & GPU
  scribe --help              Show this help message

Tag Syntax:
  (scribe: this true?)                Fast model (routed to local RTX 4070)
  (scribe -d: explain recursion)      Deep model (routed to remote machine)
  (scribe --deep: write proof)        Deep model
  (scribe:think analyze argument)     Deep model
  (scribe -v: detailed breakdown)     Verbose mode (-v / -verbose)
""")

def main():
    config = load_config()
    args = sys.argv[1:]

    if not args or args[0] in ("active", "current"):
        process_active_obsidian(config)
    elif args[0] == "scan":
        target = args[1] if len(args) > 1 else DEFAULT_VAULT
        scan_vault(target, config)
    elif args[0] == "file":
        if len(args) < 2:
            print("Error: Missing file path. Usage: scribe file <path>")
            sys.exit(1)
        process_file(args[1], config)
    elif args[0] == "test":
        test_connections(config)
    elif args[0] in ("-h", "--help", "help"):
        print_help()
    else:
        if os.path.exists(args[0]):
            process_file(args[0], config)
        else:
            print_help()

if __name__ == "__main__":
    main()
