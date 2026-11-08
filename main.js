const { Plugin, PluginSettingTab, Setting, Notice, requestUrl } = require("obsidian");
const { exec } = require("child_process");

const DEFAULT_SETTINGS = {
  localOllamaUrl: "http://localhost:11434",
  localDefaultModel: "qwen3:8b",
  localDeepModel: "qwen3.6:27b",
  remoteUrl: "https://ai.ilovemyhonda.fit",
  remoteApiKey: "",
  remoteDefaultModel: "qwen3:8b",
  remoteDeepModel: "qwen3.6:27b",
  fastTarget: "local",        // "local" or "remote"
  deepTarget: "remote",       // "local" or "remote"
  debugMode: true,            // show thinking & resource metrics
  showThinkingInNote: true,   // embed collapsible callout in note
  deepFlags: ["-d", "--deep", "deep:", "think:"],
  verboseFlags: ["-v", "--verbose"],
  systemPrompt: `You are Obsidian Scribe, a concise, high-density note-taking assistant integrated into an Obsidian vault.
RULES:
1. Provide direct, high-density responses. No conversational filler, no pleasantries (never say 'Sure!', 'Certainly!', or 'Here is...').
2. Match the exact markdown style, formatting, and indentation of the surrounding notes.
3. Output ONLY the replacement text for the (scribe:...) tag.
4. If -v or -verbose is specified, provide a thorough, detailed explanation.`
};

class OpenWebUIScribePlugin extends Plugin {
  async onload() {
    await this.loadSettings();

    // Command: Process Scribe tags in active note (Hotkey: Alt+Mod+S)
    this.addCommand({
      id: "openwebui-scribe-process",
      name: "Process Scribe tags in active note",
      editorCallback: async (editor, view) => {
        await this.processActiveEditor(editor, view.file ? view.file.path : "active note");
      }
    });

    // Command: Insert (scribe: ) tag (Hotkey: Alt+Mod+A)
    this.addCommand({
      id: "openwebui-scribe-invoke",
      name: "Insert Scribe command tag",
      editorCallback: (editor) => {
        const cursor = editor.getCursor();
        const tag = "(scribe: )";
        editor.replaceRange(tag, cursor);
        editor.setCursor({ line: cursor.line, ch: cursor.ch + 9 });
      }
    });

    // Command: Process whole vault
    this.addCommand({
      id: "openwebui-scribe-process-vault",
      name: "Scan & process Scribe tags in entire vault",
      callback: async () => {
        await this.processEntireVault();
      }
    });

    this.addSettingTab(new ScribeSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  parseTag(rawInstruction) {
    let instruction = rawInstruction.trim();
    let isDeep = false;
    let isVerbose = false;

    // Check deep flags (case-insensitive)
    for (const flag of this.settings.deepFlags) {
      const cleanFlag = flag.replace(/:+$/, "");
      const reg = new RegExp(`(^|\\s)${cleanFlag.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(?::|\\s|$)`, "i");
      if (reg.test(instruction)) {
        isDeep = true;
        instruction = instruction.replace(reg, " ").trim();
      }
    }

    // Check verbose flags (case-insensitive)
    for (const flag of this.settings.verboseFlags) {
      const cleanFlag = flag.replace(/:+$/, "");
      const reg = new RegExp(`(^|\\s)${cleanFlag.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}(?::|\\s|$)`, "i");
      if (reg.test(instruction)) {
        isVerbose = true;
        instruction = instruction.replace(reg, " ").trim();
      }
    }

    // Clean up leading colons, hyphens, or whitespace left over from flags
    instruction = instruction.replace(/^[:\-\s]+/, "").trim();

    return { instruction, isDeep, isVerbose };
  }

  async getGpuMetrics() {
    return new Promise((resolve) => {
      exec("nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu --format=csv,noheader,nounits", (err, stdout) => {
        if (err || !stdout) {
          return resolve(null);
        }
        try {
          const parts = stdout.trim().split(",").map((s) => s.trim());
          if (parts.length >= 4) {
            resolve({
              util: parts[0] + "%",
              vramUsed: (parseInt(parts[1]) / 1024).toFixed(1) + " GB",
              vramTotal: (parseInt(parts[2]) / 1024).toFixed(1) + " GB",
              temp: parts[3] + "°C"
            });
          } else {
            resolve(null);
          }
        } catch {
          resolve(null);
        }
      });
    });
  }

  async queryLocalOllama(prompt, systemPrompt, modelName) {
    const url = `${this.settings.localOllamaUrl.replace(/\/+$/, "")}/api/chat`;
    const payload = {
      model: modelName,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
      ],
      stream: false,
      options: {
        temperature: 0.2
      }
    };

    const res = await requestUrl({
      url: url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    if (res.status >= 200 && res.status < 300) {
      const data = res.json;
      let rawContent = data.message ? data.message.content : "";
      let thinking = data.message ? data.message.thinking : "";

      // Also check if content has <think>...</think>
      const thinkMatch = rawContent.match(/<think>([\s\S]*?)<\/think>/i);
      if (thinkMatch) {
        if (!thinking) thinking = thinkMatch[1].trim();
        rawContent = rawContent.replace(/<think>[\s\S]*?<\/think>/i, "").trim();
      }

      // Calculate generation metrics
      let tokPerSec = null;
      let durationSec = null;
      if (data.eval_duration && data.eval_count) {
        tokPerSec = ((data.eval_count / data.eval_duration) * 1e9).toFixed(1);
      }
      if (data.total_duration) {
        durationSec = (data.total_duration / 1e9).toFixed(2);
      }

      return {
        content: rawContent.trim(),
        thinking: thinking ? thinking.trim() : null,
        metrics: {
          target: "Local Ollama",
          model: modelName,
          tokPerSec,
          durationSec,
          evalCount: data.eval_count,
          promptTokens: data.prompt_eval_count
        }
      };
    }
    throw new Error(`Local Ollama returned HTTP ${res.status}: ${res.text}`);
  }

  async queryRemoteOpenWebUI(prompt, systemPrompt, modelName) {
    const baseUrl = this.settings.remoteUrl.replace(/\/+$/, "");
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    };
    if (this.settings.remoteApiKey) {
      headers["Authorization"] = `Bearer ${this.settings.remoteApiKey}`;
    }

    const startTime = Date.now();
    const chatUrl = `${baseUrl}/api/chat/completions`;
    const payload = {
      model: modelName,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
      stream: false
    };

    const res = await requestUrl({
      url: chatUrl,
      method: "POST",
      headers: headers,
      body: JSON.stringify(payload)
    });

    if (res.status >= 200 && res.status < 300) {
      const data = res.json;
      if (data.choices && data.choices[0] && data.choices[0].message) {
        let rawContent = data.choices[0].message.content || "";
        let thinking = data.choices[0].message.thinking || null;

        const thinkMatch = rawContent.match(/<think>([\s\S]*?)<\/think>/i);
        if (thinkMatch) {
          if (!thinking) thinking = thinkMatch[1].trim();
          rawContent = rawContent.replace(/<think>[\s\S]*?<\/think>/i, "").trim();
        }

        const durationSec = ((Date.now() - startTime) / 1000).toFixed(2);
        const tokPerSec = data.usage && data.usage.completion_tokens
          ? (data.usage.completion_tokens / parseFloat(durationSec)).toFixed(1)
          : null;

        return {
          content: rawContent.trim(),
          thinking: thinking ? thinking.trim() : null,
          metrics: {
            target: "Remote OpenWebUI",
            model: modelName,
            tokPerSec,
            durationSec,
            evalCount: data.usage ? data.usage.completion_tokens : null,
            promptTokens: data.usage ? data.usage.prompt_tokens : null
          }
        };
      }
    }

    throw new Error(`Remote OpenWebUI request failed with HTTP ${res.status}`);
  }

  findTargetSpan(fullText, tagStart, tagEnd, instruction) {
    const lowerInstr = instruction.toLowerCase();

    // 1. List Transformation (reorder, sort, rank, table, etc.)
    const listKeywords = ["reorder", "re-order", "sort", "rank", "prioritize", "reverse", "table", "dedup", "alphabetize"];
    if (listKeywords.some((k) => lowerInstr.includes(k))) {
      const preceding = fullText.slice(0, tagStart);
      const lines = preceding.split("\n");
      let endIndex = lines.length - 1;
      while (endIndex >= 0 && !lines[endIndex].trim()) endIndex--;

      let startIndex = endIndex;
      while (startIndex >= 0 && /^[-*+]\s+|\d+\.\s+/.test(lines[startIndex].trim())) startIndex--;

      if (startIndex < endIndex) {
        const listLines = lines.slice(startIndex + 1, endIndex + 1);
        const listBlockStr = listLines.join("\n");
        const blockStart = preceding.lastIndexOf(listBlockStr);
        if (blockStart !== -1) {
          return {
            type: "list",
            targetStart: blockStart,
            targetEnd: tagEnd,
            targetText: fullText.slice(blockStart, tagEnd),
            hint: "Target: Reorder or transform the preceding list block. Output ONLY the complete reordered/reformatted list matching markdown list style."
          };
        }
      }
    }

    // 2. Line Rewrite / "Explain this better"
    const rewriteKeywords = ["explain this better", "rephrase", "rewrite", "reword", "elaborate", "expand this", "make clearer", "clean up this"];
    if (rewriteKeywords.some((k) => lowerInstr.includes(k))) {
      const lineStart = fullText.lastIndexOf("\n", tagStart - 1) + 1;
      const lineBefore = fullText.slice(lineStart, tagStart);
      const match = lineBefore.match(/^(\s*(?:[-*+]|\d+\.)?\s*(?:\*\*[^*]+\*\*|__[^_]+__|[^:]+:)?\s*)(.*)$/);
      if (match && match[2].trim().length > 0) {
        const prefix = match[1];
        const targetStart = lineStart + prefix.length;
        return {
          type: "line_rewrite",
          prefix: prefix.trim(),
          targetStart: targetStart,
          targetEnd: tagEnd,
          targetText: fullText.slice(targetStart, tagEnd),
          hint: `Target: Refine and explain the concept following '${prefix.trim()}'. Provide ONLY the polished definition/explanation. Do NOT repeat '${prefix.trim()}'.`
        };
      }
    }

    // 3. Default: Inline tag replacement
    return {
      type: "inline",
      targetStart: tagStart,
      targetEnd: tagEnd,
      targetText: fullText.slice(tagStart, tagEnd),
      hint: null
    };
  }

  async callAI({ instruction, isDeep, isVerbose, context, filePath, hint }) {
    // Determine preferred location based on settings
    const preferredTarget = isDeep ? this.settings.deepTarget : this.settings.fastTarget;
    const localModel = isDeep ? this.settings.localDeepModel : this.settings.localDefaultModel;
    const remoteModel = isDeep ? this.settings.remoteDeepModel : this.settings.remoteDefaultModel;

    let sys = this.settings.systemPrompt;
    if (isVerbose) {
      sys += "\nNote: The user explicitly requested verbose explanation (-v). Provide detailed context.";
    }

    let fullPrompt = `Document Path: ${filePath}\n\nDocument Context:\n\"\"\"\n${context}\n\"\"\"\n\nInstruction/Tag: ${instruction}\n`;
    if (hint) {
      fullPrompt += `\nTask Guidance: ${hint}\n`;
    } else {
      fullPrompt += `\nProvide ONLY the replacement text for the (scribe: ...) command tag. Do not repeat the prompt.\n`;
    }

    let result = null;
    let fallbackAttempted = false;

    if (preferredTarget === "local") {
      try {
        result = await this.queryLocalOllama(fullPrompt, sys, localModel);
      } catch (localErr) {
        console.warn(`Local Ollama failed: ${localErr.message}. Attempting fallback to remote...`);
        new Notice(`Local Ollama unavailable. Falling back to remote (${this.settings.remoteUrl})...`);
        fallbackAttempted = true;
        result = await this.queryRemoteOpenWebUI(fullPrompt, sys, remoteModel);
      }
    } else {
      // Preferred is remote
      try {
        result = await this.queryRemoteOpenWebUI(fullPrompt, sys, remoteModel);
      } catch (remoteErr) {
        console.warn(`Remote OpenWebUI failed: ${remoteErr.message}. Attempting fallback to local...`);
        new Notice(`Remote OpenWebUI unavailable. Falling back to local Ollama...`);
        fallbackAttempted = true;
        result = await this.queryLocalOllama(fullPrompt, sys, localModel);
      }
    }

    // Attach local GPU metrics if available
    const gpuMetrics = await this.getGpuMetrics();
    result.gpuMetrics = gpuMetrics;
    result.fallback = fallbackAttempted;

    return result;
  }

  formatOutputWithDebug(aiResult) {
    const { content, thinking, metrics, gpuMetrics } = aiResult;

    if (!this.settings.debugMode) {
      return content;
    }

    let statsLine = `**Model:** \`${metrics.model}\` (${metrics.target})`;
    if (metrics.durationSec) statsLine += ` | **Time:** ${metrics.durationSec}s`;
    if (metrics.tokPerSec) statsLine += ` | **Speed:** ${metrics.tokPerSec} tok/s`;
    if (gpuMetrics) {
      statsLine += ` | **VRAM:** ${gpuMetrics.vramUsed} / ${gpuMetrics.vramTotal} | **GPU:** ${gpuMetrics.util} (${gpuMetrics.temp})`;
    }

    // Toast Notice with summary
    new Notice(`Scribe [${metrics.model}]: ${metrics.durationSec ? metrics.durationSec + "s" : ""} ${metrics.tokPerSec ? "(" + metrics.tokPerSec + " tok/s)" : ""}`);

    if (!this.settings.showThinkingInNote) {
      return content;
    }

    // Construct Collapsible Callout
    let callout = `> [!NOTE]- 🧠 Scribe Thought & Resource Metrics\n`;
    callout += `> ${statsLine}\n`;

    if (thinking) {
      callout += `>\n> **Thought Process:**\n`;
      const quotedThinking = thinking
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
      callout += `${quotedThinking}\n`;
    }

    return `${callout}\n${content}`;
  }

  async processActiveEditor(editor, filePath) {
    const content = editor.getValue();
    const tagRegex = /\(scribe(?::|\s+)([\s\S]*?)\)/gi;
    const matches = [...content.matchAll(tagRegex)];

    if (matches.length === 0) {
      new Notice("Scribe: No (scribe:...) tags found in active note.");
      return;
    }

    new Notice(`Scribe: Found ${matches.length} tag(s). Processing...`);

    let updatedContent = content;

    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const fullTag = match[0];
      const rawInstruction = match[1];
      const { instruction, isDeep, isVerbose } = this.parseTag(rawInstruction);

      // Determine smart target span (list block, line rewrite, or inline tag)
      const span = this.findTargetSpan(updatedContent, match.index, match.index + fullTag.length, instruction);

      const targetDesc = isDeep ? `Deep (${this.settings.deepTarget})` : `Fast (${this.settings.fastTarget})`;
      const typeLabel = span.type === "list" ? " [List Block]" : span.type === "line_rewrite" ? " [Line Rewrite]" : "";
      const notice = new Notice(`Scribe [${i + 1}/${matches.length}]: "${instruction.slice(0, 30)}..." [${targetDesc}]${typeLabel}`, 0);

      try {
        const aiResult = await this.callAI({
          instruction,
          isDeep,
          isVerbose,
          context: updatedContent,
          filePath,
          hint: span.hint
        });

        notice.hide();
        const replacement = this.formatOutputWithDebug(aiResult);
        updatedContent = updatedContent.replace(span.targetText, replacement);
        editor.setValue(updatedContent);
      } catch (err) {
        notice.hide();
        new Notice(`Scribe Error on "${instruction.slice(0, 20)}": ${err.message}`, 8000);
        console.error("Scribe processing error:", err);
      }
    }

    new Notice(`Scribe: Completed processing ${matches.length} tag(s).`);
  }

  async processEntireVault() {
    const files = this.app.vault.getMarkdownFiles();
    const tagRegex = /\(scribe(?::|\s+)([\s\S]*?)\)/i;
    const targetFiles = [];

    for (const file of files) {
      const content = await this.app.vault.read(file);
      if (tagRegex.test(content)) {
        targetFiles.push(file);
      }
    }

    if (targetFiles.length === 0) {
      new Notice("Scribe: No files in vault contain (scribe:...) tags.");
      return;
    }

    new Notice(`Scribe: Found ${targetFiles.length} file(s) with tags. Starting batch process...`);

    let processedCount = 0;
    for (const file of targetFiles) {
      let content = await this.app.vault.read(file);
      const matches = [...content.matchAll(/\(scribe(?::|\s+)([\s\S]*?)\)/gi)];

      for (const match of matches) {
        const fullTag = match[0];
        const { instruction, isDeep, isVerbose } = this.parseTag(match[1]);
        const span = this.findTargetSpan(content, match.index, match.index + fullTag.length, instruction);

        try {
          const aiResult = await this.callAI({
            instruction,
            isDeep,
            isVerbose,
            context: content,
            filePath: file.path,
            hint: span.hint
          });
          const replacement = this.formatOutputWithDebug(aiResult);
          content = content.replace(span.targetText, replacement);
          processedCount++;
        } catch (e) {
          console.error(`Scribe error in file ${file.path}:`, e);
        }
      }
      await this.app.vault.modify(file, content);
    }

    new Notice(`Scribe: Finished processing vault! Updated ${processedCount} tag(s) across ${targetFiles.length} file(s).`);
  }
}

class ScribeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "OpenWebUI Scribe Settings" });

    // --- MODEL ROUTING & LOCATIONS ---
    containerEl.createEl("h3", { text: "Model Routing & Execution Locations" });

    new Setting(containerEl)
      .setName("Standard Tasks (8B) Execution Target")
      .setDesc("Where fast, day-to-day notes requests run (Local RTX 4070 recommended for speed)")
      .addDropdown((drop) =>
        drop
          .addOption("local", "Local Ollama (RTX 4070)")
          .addOption("remote", "Remote OpenWebUI (ai.ilovemyhonda.fit)")
          .setValue(this.plugin.settings.fastTarget)
          .onChange(async (val) => {
            this.plugin.settings.fastTarget = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Deep Thinking Tasks Execution Target")
      .setDesc("Where deep thinking tasks run when using -d, --deep, or think: flags")
      .addDropdown((drop) =>
        drop
          .addOption("remote", "Remote OpenWebUI (ai.ilovemyhonda.fit)")
          .addOption("local", "Local Ollama (RTX 4070)")
          .setValue(this.plugin.settings.deepTarget)
          .onChange(async (val) => {
            this.plugin.settings.deepTarget = val;
            await this.plugin.saveSettings();
          })
      );

    // --- DEBUG & TELEMETRY ---
    containerEl.createEl("h3", { text: "Debug Mode, Thinking Text & System Metrics" });

    new Setting(containerEl)
      .setName("Enable Debug Mode")
      .setDesc("Display generation metrics (tokens/sec, duration, GPU utilization, temperature)")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.debugMode)
          .onChange(async (val) => {
            this.plugin.settings.debugMode = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Embed Thinking & Metrics Callout in Notes")
      .setDesc("Inserts a collapsible '> [!NOTE]-' callout containing the full chain of thought and hardware stats")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.showThinkingInNote)
          .onChange(async (val) => {
            this.plugin.settings.showThinkingInNote = val;
            await this.plugin.saveSettings();
          })
      );

    // --- LOCAL OLLAMA CONFIG ---
    containerEl.createEl("h3", { text: "Local Ollama (RTX 4070)" });

    new Setting(containerEl)
      .setName("Local Ollama URL")
      .setDesc("URL of your local Ollama instance")
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:11434")
          .setValue(this.plugin.settings.localOllamaUrl)
          .onChange(async (val) => {
            this.plugin.settings.localOllamaUrl = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Local Default Fast Model")
      .setDesc("8B model for fast responses (e.g. qwen3:8b)")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.localDefaultModel)
          .onChange(async (val) => {
            this.plugin.settings.localDefaultModel = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Local Deep Thinking Model")
      .setDesc("Model for local deep reasoning")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.localDeepModel)
          .onChange(async (val) => {
            this.plugin.settings.localDeepModel = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Test Local Ollama Connection")
      .setDesc("Verify that local Ollama is reachable and models are loaded")
      .addButton((btn) =>
        btn.setButtonText("Test Local").onClick(async () => {
          try {
            const res = await requestUrl({
              url: `${this.plugin.settings.localOllamaUrl.replace(/\/+$/, "")}/api/tags`
            });
            if (res.status === 200) {
              const names = res.json.models.map((m) => m.name).join(", ");
              new Notice(`Local Ollama Online! Models: ${names}`);
            } else {
              new Notice(`Local Ollama returned HTTP ${res.status}`);
            }
          } catch (e) {
            new Notice(`Local Ollama connection failed: ${e.message}`);
          }
        })
      );

    // --- REMOTE OPENWEBUI CONFIG ---
    containerEl.createEl("h3", { text: "Remote OpenWebUI (ai.ilovemyhonda.fit)" });

    new Setting(containerEl)
      .setName("Remote OpenWebUI URL")
      .setDesc("Offsite OpenWebUI server domain")
      .addText((text) =>
        text
          .setPlaceholder("https://ai.ilovemyhonda.fit")
          .setValue(this.plugin.settings.remoteUrl)
          .onChange(async (val) => {
            this.plugin.settings.remoteUrl = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Remote OpenWebUI API Key")
      .setDesc("API Key / Bearer Token for ai.ilovemyhonda.fit")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.remoteApiKey)
          .onChange(async (val) => {
            this.plugin.settings.remoteApiKey = val;
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName("Remote Default Model")
      .setDesc("Model on offsite server for standard tasks")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.remoteDefaultModel)
          .onChange(async (val) => {
            this.plugin.settings.remoteDefaultModel = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Remote Deep Thinking Model")
      .setDesc("27B or reasoning model on offsite machine")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.remoteDeepModel)
          .onChange(async (val) => {
            this.plugin.settings.remoteDeepModel = val;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Test Remote OpenWebUI Connection")
      .setDesc("Check connection to remote OpenWebUI server")
      .addButton((btn) =>
        btn.setButtonText("Test Remote").onClick(async () => {
          try {
            const url = `${this.plugin.settings.remoteUrl.replace(/\/+$/, "")}/api/models`;
            const headers = {
              "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)"
            };
            if (this.plugin.settings.remoteApiKey) {
              headers["Authorization"] = `Bearer ${this.plugin.settings.remoteApiKey}`;
            }
            const res = await requestUrl({ url, headers });
            if (res.status === 200) {
              const modelList = res.json.data.map((m) => m.id).join(", ");
              new Notice(`Remote OpenWebUI Online! Models: ${modelList}`);
            } else {
              new Notice(`Remote server returned HTTP ${res.status}: ${res.text}`);
            }
          } catch (e) {
            new Notice(`Remote connection failed: ${e.message}`);
          }
        })
      );

    // --- PROMPTS ---
    containerEl.createEl("h3", { text: "System Prompt" });

    new Setting(containerEl)
      .setName("System Prompt")
      .setDesc("Core instructions defining tone, density, and formatting rules")
      .addTextArea((ta) =>
        ta
          .setValue(this.plugin.settings.systemPrompt)
          .onChange(async (val) => {
            this.plugin.settings.systemPrompt = val;
            await this.plugin.saveSettings();
          })
      );
  }
}

module.exports = OpenWebUIScribePlugin;
